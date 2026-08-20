import type {
	ProviderAuthAttachRequest,
	ProviderAuthAttachResponse,
	ProviderAuthDetachRequest,
	ProviderAuthStatusItem,
	ProviderAuthStatusResponse,
} from "@breadboard/sdk";
import type {
	AuthCredentialView,
	AuthLoginSession,
	AuthProviderView,
	BeginAuthLogin,
	LogoutInput,
	ProviderAuthPort,
	PutApiKeyInput,
	RevokeInput,
	RevokeResult,
} from "./provider-auth-port";

export interface BreadboardProviderAuthClient {
	getProviderAuthStatus(): Promise<ProviderAuthStatusResponse>;
	attachProviderAuth(request: ProviderAuthAttachRequest): Promise<ProviderAuthAttachResponse>;
	detachProviderAuth(request: ProviderAuthDetachRequest): Promise<{ readonly ok?: boolean }>;
	readonly listProviders?: () => Promise<ReadonlyArray<Record<string, unknown>>>;
	readonly listAuthCredentials?: (input?: Record<string, unknown>) => Promise<ReadonlyArray<Record<string, unknown>>>;
	readonly startAuthLogin?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
	readonly getAuthLogin?: (loginSessionId: string) => Promise<Record<string, unknown>>;
	readonly completeAuthLogin?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
	readonly cancelAuthLogin?: (loginSessionId: string) => Promise<void>;
	readonly revokeAuthCredential?: (credentialRef: string) => Promise<RevokeResult>;
}

export class ProviderAuthFlowUnavailableError extends Error {
	readonly code = "flow_unavailable" as const;
}

function stringValue(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function credentialView(item: ProviderAuthStatusItem | Record<string, unknown>): AuthCredentialView {
	const providerId = stringValue(item.provider_id, "unknown");
	const alias = stringValue(item.alias, "default");
	const raw = item as Record<string, unknown>;
	return {
		schemaVersion: "bb.auth.credential_summary.v1",
		credentialRef: stringValue(raw.credential_ref, `${providerId}:${alias}`),
		providerId,
		authSchemeId: stringValue(raw.auth_scheme_id, "api_key"),
		credentialKind: raw.credential_kind === "oauth2" ? "oauth2" : "api_key",
		accountLabel: stringValue(raw.account_label, alias === "default" ? providerId : alias),
		status:
			raw.status === "disabled" ||
			raw.status === "revoked" ||
			raw.status === "reauthorization_required" ||
			raw.status === "quarantined"
				? raw.status
				: "active",
		source: stringValue(raw.source, "broker"),
		isDefault: raw.is_default === true,
		expiresAtUtc: typeof raw.expires_at_utc === "string" ? raw.expires_at_utc : null,
		createdAtUtc: stringValue(raw.created_at_utc, ""),
		lastUsedAtUtc: typeof raw.last_used_at_utc === "string" ? raw.last_used_at_utc : null,
	};
}

function loginSession(value: Record<string, unknown>, fallbackProviderId: string): AuthLoginSession {
	const status = value.status;
	const normalizedStatus =
		status === "completed" ||
		status === "cancelled" ||
		status === "failed" ||
		status === "unavailable" ||
		status === "awaiting_input"
			? status
			: "pending";
	const credential = value.credential;
	return {
		loginSessionId: stringValue(value.login_session_id ?? value.loginSessionId, "unknown"),
		providerId: stringValue(value.provider_id ?? value.providerId, fallbackProviderId),
		status: normalizedStatus,
		...(typeof value.authorize_url === "string" || typeof value.authorizeUrl === "string"
			? { authorizeUrl: stringValue(value.authorize_url ?? value.authorizeUrl, "") }
			: {}),
		...(typeof value.launch_url === "string" || typeof value.launchUrl === "string"
			? { launchUrl: stringValue(value.launch_url ?? value.launchUrl, "") }
			: {}),
		...(typeof value.instructions === "string" ? { instructions: value.instructions } : {}),
		...(typeof value.prompt === "string" ? { prompt: value.prompt } : {}),
		...(credential && typeof credential === "object" && !Array.isArray(credential)
			? { credential: credentialView(credential as Record<string, unknown>) }
			: {}),
		...(value.problem && typeof value.problem === "object" && !Array.isArray(value.problem)
			? {
					problem: {
						code: stringValue((value.problem as Record<string, unknown>).code, "provider_auth_error"),
						message: stringValue(
							(value.problem as Record<string, unknown>).message,
							"Provider authentication failed",
						),
					},
				}
			: {}),
	};
}

function unavailableLogin(input: BeginAuthLogin): AuthLoginSession {
	return {
		loginSessionId: "",
		providerId: input.providerId,
		status: "unavailable",
		problem: {
			code: "flow_unavailable",
			message: `No established login flow is available for provider '${input.providerId}'.`,
		},
	};
}

/** Maps the snake_case SDK wire surface to the fork's camelCase UI port. */
export function createBreadboardProviderAuthPort(client: BreadboardProviderAuthClient): ProviderAuthPort {
	const listCredentials = async (providerId?: string): Promise<ReadonlyArray<AuthCredentialView>> => {
		if (client.listAuthCredentials) {
			const rows = await client.listAuthCredentials(providerId ? { providerId } : undefined);
			return rows.map(row => credentialView(row));
		}
		const response = await client.getProviderAuthStatus();
		return (response.attached ?? []).filter(row => !providerId || row.provider_id === providerId).map(credentialView);
	};

	return {
		async listProviders(): Promise<ReadonlyArray<AuthProviderView>> {
			if (client.listProviders) {
				const rows = await client.listProviders();
				return rows.map(row => ({
					providerId: stringValue(row.provider_id ?? row.providerId, "unknown"),
					displayName: stringValue(row.display_name ?? row.displayName ?? row.provider_id, "Unknown provider"),
					available: row.available !== false,
					authSchemes: Array.isArray(row.auth_schemes)
						? row.auth_schemes.filter((value): value is string => typeof value === "string")
						: ["api_key"],
					loginAvailable: row.login_available === true,
				}));
			}
			const credentials = await listCredentials();
			const providers = new Map<string, AuthProviderView>();
			for (const credential of credentials) {
				providers.set(credential.providerId, {
					providerId: credential.providerId,
					displayName: credential.providerId,
					available: true,
					authSchemes: [credential.authSchemeId],
					loginAvailable: false,
				});
			}
			return [...providers.values()];
		},
		listCredentials,
		async beginLogin(input) {
			if (!client.startAuthLogin) return unavailableLogin(input);
			return loginSession(
				await client.startAuthLogin({
					providerId: input.providerId,
					flow: input.flow,
					accountLabel: input.accountLabel,
					makeDefault: input.makeDefault,
					headless: input.headless,
				}),
				input.providerId,
			);
		},
		async getLogin(loginSessionId) {
			if (!client.getAuthLogin) throw new ProviderAuthFlowUnavailableError("No login status endpoint is available");
			return loginSession(await client.getAuthLogin(loginSessionId), "unknown");
		},
		async completeLogin(input) {
			if (!client.completeAuthLogin)
				throw new ProviderAuthFlowUnavailableError("No login completion endpoint is available");
			return loginSession(
				await client.completeAuthLogin({
					loginSessionId: input.loginSessionId,
					redirectOrCode: input.redirectOrCode,
				}),
				"unknown",
			);
		},
		async cancelLogin(loginSessionId) {
			if (!client.cancelAuthLogin)
				throw new ProviderAuthFlowUnavailableError("No login cancellation endpoint is available");
			await client.cancelAuthLogin(loginSessionId);
		},
		async putApiKey(input: PutApiKeyInput) {
			const response = await client.attachProviderAuth({
				material: {
					provider_id: input.providerId,
					api_key: input.apiKey,
					headers: input.bindings ?? {},
				},
			});
			const detail = response.detail?.credential;
			return credentialView(
				detail && typeof detail === "object"
					? (detail as Record<string, unknown>)
					: { provider_id: input.providerId, account_label: input.accountLabel },
			);
		},
		async logout(input: LogoutInput) {
			const credential = (await listCredentials()).find(row => row.credentialRef === input.credentialRef);
			if (!credential) throw new Error(`Unknown credential reference: ${input.credentialRef}`);
			await client.detachProviderAuth({ provider_id: credential.providerId, alias: credential.accountLabel });
		},
		async revoke(input: RevokeInput) {
			if (!client.revokeAuthCredential)
				throw new ProviderAuthFlowUnavailableError("No credential revoke endpoint is available");
			return client.revokeAuthCredential(input.credentialRef);
		},
	};
}
