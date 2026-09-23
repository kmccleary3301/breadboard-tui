import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { PASTE_CODE_LOGIN_PROVIDERS } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthPrompt, OAuthProvider } from "@oh-my-pi/pi-ai/oauth/types";
import { type Component, type Focusable, Container } from "../../tui";
import { Spacer } from "../../components/spacer";
import { Text } from "../../components/text";
import { WizardStep } from "../../components/wizard-step";
import { Input } from "../../components/input";
import { matchesKey } from "../../keys";
import { type SgrMouseEvent } from "../../mouse";
import { wrapTextWithAnsi } from "../../utils";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import { OAuthSelectorComponent, type ProviderAuthReadPort } from "../../overlays/oauth-selector";
import { getProductIdentity } from "../../product-identity";
import { theme } from "../../theme/theme";
import type { SetupSceneHost, SetupTab } from "./types";

const UNAVAILABLE_PROVIDER_SOURCE: ProviderAuthReadPort = Object.freeze({
	listProvidersSync: () => [],
	listCredentialsSync: () => [],
	async listProviders() {
		return [];
	},
	async listCredentials() {
		return [];
	},
});

interface ProviderAuthFailure {
	readonly code: string;
	readonly message: string;
	readonly nextAction: string;
}

function isProviderAuthFailure(error: unknown): error is ProviderAuthFailure {
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { code?: unknown; message?: unknown; nextAction?: unknown };
	return (
		typeof candidate.code === "string" &&
		typeof candidate.message === "string" &&
		typeof candidate.nextAction === "string"
	);
}

function createNativeProviderAuthDataSource(authStorage: AuthStorage): ProviderAuthReadPort {
	return {
		listProvidersSync: () =>
			getOAuthProviders().map(provider => ({
				providerId: provider.id,
				displayName: provider.name,
				supportTier: "core" as const,
				authOwner: "provider" as const,
				available: provider.available,
				authSchemes: ["oauth2" as const],
				loginAvailable: provider.available,
				oauthFlows: [] as const,
				storeCredentialsAs: provider.storeCredentialsAs,
			})),
		listCredentialsSync: providerId =>
			authStorage.listStoredCredentials?.(providerId).map(row => ({
				providerId: row.provider,
				status: row.disabledCause ? ("disabled" as const) : ("active" as const),
			})) ?? [],
		async listProviders() {
			return this.listProvidersSync?.() ?? [];
		},
		async listCredentials(providerId) {
			return this.listCredentialsSync?.(providerId) ?? [];
		},
	};
}

function loginUrlLink(url: string): string {
	return `\x1b]8;;${url}\x07Open login URL\x1b]8;;\x07`;
}

function loginCopyHint(): string {
	return theme.fg("dim", "(clipboard copy attempted; Alt+C retries)");
}

class CopyablePromptInput implements Component, Focusable {
	#input: Input;
	#onCopy: () => void;

	constructor(input: Input, onCopy: () => void) {
		this.#input = input;
		this.#onCopy = onCopy;
	}

	get focused(): boolean {
		return this.#input.focused;
	}

	set focused(value: boolean) {
		this.#input.focused = value;
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#input.setUseTerminalCursor(useTerminalCursor);
	}

	render(width: number): readonly string[] {
		return this.#input.render(width);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "alt+c")) {
			this.#onCopy();
			return;
		}
		this.#input.handleInput(data);
	}

	clear(): void {
		this.#input.setValue("");
		this.#input.mask = false;
	}

	invalidate(): void {
		this.#input.invalidate();
	}
}

interface PromptState {
	message: string;
	placeholder?: string;
	input: CopyablePromptInput;
}

/**
 * "Sign in" panel: lets the user authenticate one or more model providers via
 * OAuth. Unlike a standalone scene it never auto-advances the wizard — the user
 * may sign in to several providers and then continue with Esc.
 */
export class SignInTab implements SetupTab {
	readonly id = "sign-in";
	readonly label = "Sign in";

	/** Undefined when the product has neither a credential broker nor a native store to sign in to. */
	#authStorage: AuthStorage | undefined;
	#selector: OAuthSelectorComponent;
	#statusLines: string[] = [];
	#authUrl: string | undefined;
	#authLaunchUrl: string | undefined;
	#prompt: PromptState | undefined;
	#promptResolve: ((value: string) => void) | undefined;
	#promptReject: ((error: Error) => void) | undefined;
	#promptAbortCleanup: (() => void) | undefined;
	#loginAbort: AbortController | undefined;
	#loggingInProvider: string | undefined;
	#disposed = false;
	#step: WizardStep | undefined;

	readonly #host: SetupSceneHost;

	constructor(host: SetupSceneHost) {
		this.#host = host;
		this.#authStorage = host.ctx.authStorage;
		this.#selector = this.#createSelector();
	}

	/** Modal while an OAuth flow is running so the scene won't switch tabs or finish. */
	get modal(): boolean {
		return this.#loggingInProvider !== undefined;
	}

	dispose(): void {
		this.#disposed = true;
		this.#selector.stopValidation();
		this.#loginAbort?.abort();
		this.#resolvePrompt("");
	}

	invalidate(): void {
		this.#step?.invalidate();
		this.#selector.invalidate();
		this.#prompt?.input.invalidate();
	}

	handleInput(data: string): void {
		if (this.#loggingInProvider) {
			if (this.#prompt) {
				this.#prompt.input.handleInput(data);
				return;
			}
			if (this.#authUrl && (matchesKey(data, "alt+c") || (data === "c" && !this.#prompt))) {
				void this.#copyAuthUrl();
				return;
			}
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				this.#loginAbort?.abort();
			}
			return;
		}
		this.#selector.handleInput(data);
	}

	/** Forward mouse to the provider selector; pointer is inert during an active login or code prompt. */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (this.#loggingInProvider || this.#prompt) return;
		this.#step?.routeMouse(event, line, col);
	}

	render(width: number, maxLines?: number): readonly string[] {
		// Hint + blank cost two rows; the wizard subtitle already explains
		// this panel, so on short screens the rows go to the provider list
		// instead (17 = full selector: 4 chrome above, 10 rows, 3 below).
		let intro: Container | undefined;
		if (this.#loggingInProvider === undefined && this.#providerSetupUnavailable) {
			const identity = this.#host.ctx.identity ?? getProductIdentity();
			intro = new Container();
			intro.addChild(new Text(theme.fg("error", `${identity.displayName} provider setup is unavailable.`), 0, 0));
			intro.addChild(
				new Text(
					theme.fg(
						"dim",
						`Press Esc to continue; retry with \`${identity.cliName} setup\` when the auth broker is ready.`,
					),
					0,
					0,
				),
			);
			intro.addChild(new Spacer(1));
		} else if (this.#loggingInProvider === undefined && (maxLines === undefined || maxLines >= 17 + 2)) {
			intro = new Container();
			intro.addChild(
				new Text(theme.fg("muted", "Pick a provider to sign in — you can connect more than one."), 0, 0),
			);
			intro.addChild(new Spacer(1));
		}
		const tail = new Container();
		const urlLines = this.#authUrl ? wrapTextWithAnsi(theme.fg("dim", this.#authUrl), width) : [];
		if (this.#authUrl) {
			tail.addChild(
				new Text(theme.fg("accent", `Browser login: ${loginUrlLink(this.#authUrl)} ${loginCopyHint()}`), 0, 0),
			);
			// Keep one URL row above the prompt; repeat the complete wrapped URL
			// below so the input remains visible in the wizard's short viewport.
			if (urlLines[0]) tail.addChild(new Text(urlLines[0], 0, 0));
			if (this.#authLaunchUrl) {
				tail.addChild(
					new Text(theme.fg("dim", `Local shortcut (this machine only): ${this.#authLaunchUrl}`), 0, 0),
				);
			}
		}
		if (this.#prompt) {
			tail.addChild(new Text(theme.fg("warning", this.#prompt.message), 0, 0));
			if (this.#prompt.placeholder) {
				tail.addChild(new Text(theme.fg("dim", this.#prompt.placeholder), 0, 0));
			}
			tail.addChild(this.#prompt.input);
		}
		if (urlLines.length > 1) {
			for (const line of urlLines) {
				tail.addChild(new Text(line, 0, 0));
			}
		}
		for (const line of this.#statusLines) {
			for (const wrapped of wrapTextWithAnsi(line, width)) {
				tail.addChild(new Text(wrapped, 0, 0));
			}
		}
		if (!this.#step) {
			this.#step = new WizardStep({
				kind: "choice",
				content: this.#selector,
				gap: 0,
				fitContent: budget => {
					if (budget !== undefined) this.#selector.setMaxHeight(budget);
				},
			});
		}
		if (this.#loggingInProvider) {
			this.#step.setKind("async");
			this.#step.setHeading(new Text(theme.bold(`Signing in to ${this.#loggingInProvider}`), 0, 0));
			this.#step.setIntro(undefined);
			this.#step.setContent(tail);
			this.#step.setStatus(undefined);
		} else {
			this.#step.setKind("choice");
			this.#step.setHeading(undefined);
			this.#step.setIntro(intro);
			this.#step.setContent(this.#selector);
			this.#step.setStatus(tail);
		}
		this.#step.setMaxHeight(maxLines);
		return this.#step.render(width);
	}

	get #providerSetupUnavailable(): boolean {
		return !this.#host.ctx.providerAuth && !this.#authStorage;
	}

	#createSelector(): OAuthSelectorComponent {
		return new OAuthSelectorComponent(
			"login",
			this.#host.ctx.providerAuth ??
				(this.#authStorage ? createNativeProviderAuthDataSource(this.#authStorage) : UNAVAILABLE_PROVIDER_SOURCE),
			providerId => {
				void this.#login(providerId);
			},
			() => this.#host.finish("skipped"),
			{
				requestRender: () => this.#host.requestRender(),
				disabledProviders: this.#host.ctx.disabledProviders,
				validateAuth: this.#host.ctx.providerAuth
					? async providerId =>
							(await this.#host.ctx.providerAuth?.listCredentials(providerId))?.some(
								credential => credential.status === "active",
							) === true
					: undefined,
			},
		);
	}

	async #login(providerId: string): Promise<void> {
		if (this.#loggingInProvider || this.#disposed) return;
		const providerAuth = this.#host.ctx.providerAuth;
		const useManualInput = !providerAuth && PASTE_CODE_LOGIN_PROVIDERS.has(providerId);
		this.#selector.stopValidation();
		this.#loggingInProvider = providerId;
		this.#statusLines = [theme.fg("dim", providerAuth ? "Starting authentication flow…" : "Starting OAuth flow…")];
		this.#authUrl = undefined;
		this.#authLaunchUrl = undefined;
		this.#loginAbort = new AbortController();
		this.#host.restoreFocus();
		this.#host.requestRender();
		try {
			let accountLabel: string | undefined;
			if (providerAuth) {
				const result = await providerAuth.authenticate(providerId, {
					signal: this.#loginAbort.signal,
					selectAuthScheme: async (provider, schemes) => {
						const choices = schemes.map((scheme, index) => `${index + 1}) ${scheme}`).join("  ");
						const answer = (
							await this.#showPrompt({
								message: `Choose authentication for ${provider.displayName}: ${choices}`,
							})
						).trim();
						return schemes[Number.parseInt(answer, 10) - 1] ?? answer;
					},
					selectOAuthFlow: async provider => {
						const flows = provider.oauthFlows.filter(
							(flow): flow is "browser" | "device" => flow === "browser" || flow === "device",
						);
						if (flows.length <= 1) return flows[0];
						const choices = flows.map((flow, index) => `${index + 1}) ${flow}`).join("  ");
						const answer = (await this.#showPrompt({ message: `Choose OAuth flow: ${choices}` })).trim();
						const selectedByName = answer === "browser" || answer === "device" ? answer : undefined;
						return flows[Number.parseInt(answer, 10) - 1] ?? selectedByName;
					},
					showAuthorization: session => {
						this.#statusLines = [];
						if (session.instructions) this.#statusLines.push(theme.fg("warning", session.instructions));
						if (session.userCode) this.#statusLines.push(theme.fg("warning", `Code: ${session.userCode}`));
						if (session.authorizeUrl) {
							this.#authUrl = session.authorizeUrl;
							void this.#copyAuthUrl();
							this.#host.ctx.openInBrowser(session.authorizeUrl);
						}
						this.#host.requestRender();
					},
					prompt: input => this.#showPrompt(input),
					showProgress: message => {
						this.#statusLines.push(theme.fg("dim", message));
						this.#host.requestRender();
					},
				});
				accountLabel = result.accountLabel;
			} else {
				const authStorage = this.#authStorage;
				if (!authStorage) {
					const { displayName } = this.#host.ctx.identity ?? getProductIdentity();
					throw new Error(`${displayName} provider setup is unavailable`);
				}
				const identity = await authStorage.login(providerId as OAuthProvider, {
					signal: this.#loginAbort.signal,
					onBrowserSession: (request, signal) => this.#host.ctx.captureBrowserSession(request, signal),
					onAuth: info => {
						this.#authUrl = info.url;
						this.#authLaunchUrl = info.launchUrl && info.launchUrl !== info.url ? info.launchUrl : undefined;
						this.#statusLines = [];
						if (info.instructions) this.#statusLines.push(theme.fg("warning", info.instructions));
						if (useManualInput) {
							this.#statusLines.push(theme.fg("dim", "Paste the returned code or redirect URL when prompted."));
						}
						void this.#copyAuthUrl();
						this.#host.ctx.openInBrowser(info.url);
						this.#host.requestRender();
					},
					onPrompt: prompt => this.#showPrompt(prompt),
					onProgress: message => {
						this.#statusLines.push(theme.fg("dim", message));
						this.#host.requestRender();
					},
					onManualCodeInput: signal =>
						this.#showPrompt({ message: "Paste the authorization code (or full redirect URL):" }, signal),
				});
				accountLabel = identity?.type === "oauth" ? (identity.email ?? identity.accountId) : undefined;
				await this.#host.ctx.refreshProvider(providerId);
			}
			if (this.#disposed) return;
			const account = accountLabel ? ` as ${accountLabel}` : "";
			const brokerName = this.#host.ctx.identity?.displayName ?? "auth";
			this.#statusLines = [
				theme.fg("success", `${theme.status.success} Signed in to ${providerId}${account}`),
				theme.fg(
					"dim",
					providerAuth ? `Credentials managed by ${brokerName} auth broker` : `Credentials saved to ${getAgentDbPath()}`,
				),
			];
			this.#authUrl = undefined;
			this.#authLaunchUrl = undefined;
			this.#loggingInProvider = undefined;
			this.#loginAbort = undefined;
			this.#selector.stopValidation();
			this.#selector = this.#createSelector();
			this.#host.restoreFocus();
			this.#host.requestRender();
		} catch (error) {
			if (this.#disposed) return;
			if (this.#loginAbort?.signal.aborted) {
				this.#statusLines = [theme.fg("dim", "Login cancelled.")];
			} else if (isProviderAuthFailure(error)) {
				this.#statusLines = [
					theme.fg("error", `Login failed [${error.code}]: ${error.message}`),
					theme.fg("dim", error.nextAction),
				];
			} else {
				const message = error instanceof Error ? error.message : String(error);
				this.#statusLines = [
					theme.fg("error", `Login failed: ${message}`),
					theme.fg("dim", "Choose another provider or press Esc to continue."),
				];
			}
			this.#authUrl = undefined;
			this.#authLaunchUrl = undefined;
			this.#loggingInProvider = undefined;
			this.#loginAbort = undefined;
			this.#host.restoreFocus();
			this.#host.requestRender();
		}
	}

	async #copyAuthUrl(): Promise<void> {
		const url = this.#authUrl;
		if (!url) return;
		try {
			await this.#host.ctx.copyToClipboard(url);
		} catch {
			// Clipboard integration is best-effort; the full URL remains rendered below.
		}
		this.#host.requestRender();
	}
	#showPrompt(prompt: OAuthPrompt, signal?: AbortSignal): Promise<string> {
		this.#resolvePrompt("");
		if (signal?.aborted) {
			return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Login input cancelled"));
		}
		const input = new Input();
		input.mask = prompt.secret === true;
		const focusInput = new CopyablePromptInput(input, () => {
			void this.#copyAuthUrl();
		});
		const pending = Promise.withResolvers<string>();
		this.#promptResolve = pending.resolve;
		this.#promptReject = pending.reject;
		this.#prompt = { message: prompt.message, placeholder: prompt.placeholder, input: focusInput };
		if (signal) {
			const onAbort = () => {
				if (this.#promptReject !== pending.reject) return;
				this.#rejectPrompt(signal.reason instanceof Error ? signal.reason : new Error("Login input cancelled"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			this.#promptAbortCleanup = () => signal.removeEventListener("abort", onAbort);
		}
		input.onSubmit = value => {
			focusInput.clear();
			this.#resolvePrompt(value);
		};
		input.onEscape = () => {
			this.#loginAbort?.abort();
			focusInput.clear();
			this.#resolvePrompt("");
		};
		this.#host.setFocus(focusInput);
		this.#host.requestRender();
		return pending.promise;
	}

	#resolvePrompt(value: string): void {
		const resolve = this.#promptResolve;
		if (!resolve) return;
		this.#clearPrompt();
		resolve(value);
	}

	#rejectPrompt(error: Error): void {
		const reject = this.#promptReject;
		if (!reject) return;
		this.#clearPrompt();
		reject(error);
	}

	#clearPrompt(): void {
		this.#promptAbortCleanup?.();
		this.#promptAbortCleanup = undefined;
		this.#promptResolve = undefined;
		this.#promptReject = undefined;
		this.#prompt = undefined;
		this.#host.restoreFocus();
		this.#host.requestRender();
	}
}
