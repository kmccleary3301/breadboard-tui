import {
	type AuthCredentialView,
	type AuthLoginSession,
	type AuthProviderFlow,
	type AuthProviderView,
	ProviderAuthError,
	type ProviderAuthPort,
} from "./provider-auth-port";

const SUPPORTED_AUTH_SCHEMES: Record<string, true> = { api_key: true, oauth2: true };

export interface ProviderAuthPrompt {
	readonly message: string;
	readonly placeholder?: string;
	readonly secret: boolean;
}

export interface ProviderAuthLoginPresenter {
	readonly signal: AbortSignal;
	selectAuthScheme(provider: AuthProviderView, schemes: readonly string[]): Promise<string>;
	selectOAuthFlow?(provider: AuthProviderView): Promise<AuthProviderFlow | undefined>;
	showAuthorization(session: AuthLoginSession): void;
	prompt(input: ProviderAuthPrompt): Promise<string>;
	showProgress(message: string): void;
}
export interface AuthenticateProviderOptions {
	readonly authSchemeId?: string;
	readonly pollIntervalMs?: number;
	readonly timeoutMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;

function waitForPoll(signal: AbortSignal, delayMs: number): Promise<void> {
	if (signal.aborted) return Promise.reject(cancellation());
	if (delayMs <= 0) return Promise.resolve();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(() => {
		signal.removeEventListener("abort", abort);
		resolve();
	}, delayMs);
	const abort = () => {
		clearTimeout(timer);
		reject(cancellation());
	};
	signal.addEventListener("abort", abort, { once: true });
	return promise;
}

function cancellation(): ProviderAuthError {
	return new ProviderAuthError({
		code: "provider_auth_cancelled",
		message: "Provider login cancelled.",
		nextAction: "Choose a provider to start again.",
	});
}

function assertOpen(signal: AbortSignal): void {
	if (signal.aborted) throw cancellation();
}

function usableSchemes(provider: AuthProviderView): string[] {
	return provider.authSchemes.filter(
		scheme => SUPPORTED_AUTH_SCHEMES[scheme] === true && (scheme !== "oauth2" || provider.loginAvailable),
	);
}

async function selectScheme(
	provider: AuthProviderView,
	presenter: ProviderAuthLoginPresenter,
	requestedScheme: string | undefined,
): Promise<string> {
	const schemes = usableSchemes(provider);
	if (requestedScheme) {
		if (!schemes.includes(requestedScheme)) {
			throw new ProviderAuthError({
				code: "unsupported_auth_scheme",
				message: `${provider.displayName} does not support ${requestedScheme}.`,
				nextAction: "Choose one of the provider's available authentication methods.",
			});
		}
		return requestedScheme;
	}
	if (schemes.length === 1) {
		const scheme = schemes[0];
		if (scheme) return scheme;
	}
	if (schemes.length > 1) {
		const selected = await presenter.selectAuthScheme(provider, schemes);
		if (schemes.includes(selected)) return selected;
	}
	throw new ProviderAuthError({
		code: "provider_auth_unavailable",
		message: `${provider.displayName} has no supported BreadBoard authentication method.`,
		nextAction:
			provider.availabilityReason === "provider_managed"
				? "Use the provider's own login flow."
				: "Choose another provider.",
	});
}

function requireProvider(providers: readonly AuthProviderView[], requestedId: string): AuthProviderView {
	const provider = providers.find(row => row.providerId === requestedId || row.aliases.includes(requestedId));
	if (!provider) {
		throw new ProviderAuthError({
			code: "unknown_provider",
			message: `Unknown BreadBoard provider: ${requestedId}`,
			nextAction: "Open the provider selector and choose a listed provider.",
		});
	}
	if (
		provider.supportTier !== "core" ||
		provider.authOwner !== "broker" ||
		(!provider.available && provider.availabilityReason !== "missing_auth")
	) {
		throw new ProviderAuthError({
			code: "provider_auth_unavailable",
			message: `${provider.displayName} is unavailable for BreadBoard-managed login.`,
			nextAction:
				provider.availabilityReason === "provider_managed"
					? "Use the provider's own login flow."
					: "Choose another available provider.",
		});
	}
	return provider;
}

async function storeApiKey(
	port: ProviderAuthPort,
	provider: AuthProviderView,
	presenter: ProviderAuthLoginPresenter,
): Promise<AuthCredentialView> {
	const accountLabel = (
		await presenter.prompt({
			message: `Account label for ${provider.displayName}:`,
			placeholder: "work",
			secret: false,
		})
	).trim();
	assertOpen(presenter.signal);
	if (!accountLabel) {
		throw new ProviderAuthError({
			code: "account_label_required",
			message: "An account label is required.",
			nextAction: "Enter a non-secret label such as work or personal.",
		});
	}
	let apiKey = await presenter.prompt({
		message: `API key for ${provider.displayName}:`,
		secret: true,
	});
	try {
		assertOpen(presenter.signal);
		if (!apiKey.trim()) {
			throw new ProviderAuthError({
				code: "api_key_required",
				message: "An API key is required.",
				nextAction: "Paste a valid key or cancel provider setup.",
			});
		}
		const credential = await port.putApiKey({
			providerId: provider.providerId,
			authSchemeId: "api_key",
			accountLabel,
			apiKey,
		});
		assertOpen(presenter.signal);
		return credential;
	} finally {
		apiKey = "";
	}
}

function completedCredential(session: AuthLoginSession): AuthCredentialView {
	if (session.status === "completed" && session.credential) return session.credential;
	const message = session.problem?.message ?? `Provider login ${session.status}.`;
	throw new ProviderAuthError({
		code: session.problem?.code ?? `provider_login_${session.status}`,
		message,
		nextAction: "Retry login or choose another authentication method.",
	});
}

async function completeOAuth(
	port: ProviderAuthPort,
	provider: AuthProviderView,
	presenter: ProviderAuthLoginPresenter,
	options: CompleteOAuthOptions,
): Promise<AuthCredentialView> {
	const flow = await presenter.selectOAuthFlow?.(provider);
	if (flow && !provider.oauthFlows.includes(flow)) {
		throw new ProviderAuthError({
			code: "unsupported_oauth_flow",
			message: `${provider.displayName} does not support the ${flow} OAuth flow.`,
			nextAction: "Choose one of the provider's advertised OAuth flows.",
		});
	}
	assertOpen(presenter.signal);
	let session = await port.beginLogin({
		providerId: provider.providerId,
		authSchemeId: "oauth2",
		...(flow ? { flow } : {}),
	});
	let cancelRequested = false;
	const cancel = () => {
		if (cancelRequested) return;
		cancelRequested = true;
		void port.cancelLogin(session.loginSessionId).catch(() => undefined);
	};
	presenter.signal.addEventListener("abort", cancel, { once: true });
	if (presenter.signal.aborted) cancel();
	try {
		assertOpen(presenter.signal);
		if (session.authorizeUrl || session.userCode || session.instructions) {
			presenter.showAuthorization(session);
		}
		const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS);
		while (session.status === "pending" || session.status === "awaiting_input") {
			if (session.prompt) {
				const redirectOrCode = await presenter.prompt({
					message: session.prompt,
					secret: false,
				});
				assertOpen(presenter.signal);
				session = await port.completeLogin({
					loginSessionId: session.loginSessionId,
					redirectOrCode,
				});
				continue;
			}
			if (Date.now() >= deadline) {
				cancelRequested = true;
				await port.cancelLogin(session.loginSessionId).catch(() => undefined);
				throw new ProviderAuthError({
					code: "provider_login_timeout",
					message: `${provider.displayName} login timed out.`,
					nextAction: "Start login again and complete authorization before it expires.",
				});
			}
			presenter.showProgress("Waiting for provider authorization…");
			await waitForPoll(presenter.signal, pollIntervalMs);
			assertOpen(presenter.signal);
			session = await port.getLogin(session.loginSessionId);
		}
		assertOpen(presenter.signal);
		return completedCredential(session);
	} finally {
		presenter.signal.removeEventListener("abort", cancel);
	}
}

interface CompleteOAuthOptions {
	readonly pollIntervalMs?: number;
	readonly timeoutMs?: number;
}

export async function authenticateProvider(
	port: ProviderAuthPort,
	providerId: string,
	presenter: ProviderAuthLoginPresenter,
	options: AuthenticateProviderOptions = {},
): Promise<AuthCredentialView> {
	assertOpen(presenter.signal);
	const provider = requireProvider(await port.listProviders(), providerId);
	const scheme = await selectScheme(provider, presenter, options.authSchemeId);
	assertOpen(presenter.signal);
	return scheme === "api_key"
		? storeApiKey(port, provider, presenter)
		: completeOAuth(port, provider, presenter, options);
}
