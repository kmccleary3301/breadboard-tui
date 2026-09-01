import { ApiError, type BreadboardClient } from "@breadboard/sdk/engine";
import { parseCallbackInput } from "@oh-my-pi/pi-ai/oauth/callback-server";
import {
	type AuthCredentialKind,
	type AuthCredentialRefreshState,
	type AuthCredentialRefreshStatus,
	type AuthCredentialStatus,
	type AuthCredentialView,
	type AuthLoginSession,
	type AuthLoginStatus,
	type AuthProviderAuthOwner,
	type AuthProviderAvailabilityReason,
	type AuthProviderFlow,
	type AuthProviderModelDiscovery,
	type AuthProviderSupportTier,
	type AuthProviderView,
	type AuthSchemeId,
	type BeginAuthLogin,
	type CompleteAuthLogin,
	type LogoutInput,
	ProviderAuthError,
	type ProviderAuthPort,
	type PutApiKeyInput,
	type RevokeInput,
} from "./provider-auth-port";

type BreadboardProviderAuthClient = Pick<
	BreadboardClient,
	| "listProviders"
	| "listCredentials"
	| "beginLogin"
	| "getLogin"
	| "completeLogin"
	| "cancelLogin"
	| "putApiKey"
	| "logout"
	| "revoke"
>;
type AsyncResult<Operation> = Operation extends (...args: never[]) => Promise<infer Result> ? Result : never;
type SdkAuthProviderView = AsyncResult<BreadboardProviderAuthClient["listProviders"]>[number];
type SdkAuthCredentialView = AsyncResult<BreadboardProviderAuthClient["listCredentials"]>[number];
type SdkAuthCredentialRefreshState = NonNullable<SdkAuthCredentialView["refresh_state"]>;
type SdkAuthLoginSession = AsyncResult<BreadboardProviderAuthClient["beginLogin"]>;

function utc(milliseconds: number | null | undefined): string | null {
	return milliseconds == null ? null : new Date(milliseconds).toISOString();
}

function optionalUtc(milliseconds: number | null | undefined): string | null | undefined {
	return milliseconds === undefined ? undefined : utc(milliseconds);
}

function authScheme(value: string | null | undefined): AuthSchemeId {
	return value === "oauth2" ? "oauth2" : "api_key";
}

function credentialKind(value: string | null | undefined): AuthCredentialKind {
	return value === "oauth2" ? "oauth2" : "api_key";
}

function hasSupportedCredentialClassification(row: SdkAuthCredentialView): boolean {
	return (
		(row.auth_scheme_id === "oauth2" || row.auth_scheme_id === "api_key") &&
		(row.credential_kind === "oauth2" || row.credential_kind === "api_key")
	);
}

function credentialStatus(value: string): AuthCredentialStatus {
	switch (value) {
		case "active":
		case "disabled":
		case "revoked":
		case "reauthorization_required":
		case "quarantined":
			return value;
		default:
			return "quarantined";
	}
}

function refreshStatus(value: string): AuthCredentialRefreshStatus {
	switch (value) {
		case "idle":
		case "refreshing":
		case "failed":
		case "blocked":
			return value;
		default:
			return "unknown";
	}
}

function providerSupportTier(value: string): AuthProviderSupportTier {
	return value === "core" ? "core" : "unsupported";
}

function providerAuthOwner(value: string): AuthProviderAuthOwner {
	return value === "broker" ? "broker" : "provider";
}

function providerAvailabilityReason(
	value: string | null | undefined,
): AuthProviderAvailabilityReason | null | undefined {
	if (value === undefined || value === null) return value;
	switch (value) {
		case "provider_managed":
		case "missing_auth":
			return value;
		default:
			return "unsupported";
	}
}

function providerAuthSchemes(values: readonly string[]): AuthSchemeId[] {
	return values.flatMap(value => (value === "oauth2" || value === "api_key" ? [value] : []));
}

function providerOAuthFlows(values: readonly string[] | undefined): AuthProviderFlow[] {
	return (values ?? []).flatMap(value => (value === "browser" || value === "device" ? [value] : []));
}

function providerModelDiscovery(value: string): AuthProviderModelDiscovery {
	return value === "configured_only" ? "configured_only" : "unsupported";
}

function refreshState(row: SdkAuthCredentialRefreshState): AuthCredentialRefreshState {
	const leaseAcquiredAtUtc = optionalUtc(row.lease_acquired_at_ms);
	const leaseExpiresAtUtc = optionalUtc(row.lease_expires_at_ms);
	const lastFailureAtUtc = optionalUtc(row.last_failure_at_ms);
	const retryNotBeforeUtc = optionalUtc(row.retry_not_before_ms);
	const updatedAtUtc = optionalUtc(row.updated_at_ms);
	return {
		status: refreshStatus(row.status),
		...(row.expected_secret_version !== undefined ? { expectedSecretVersion: row.expected_secret_version } : {}),
		...(leaseAcquiredAtUtc !== undefined ? { leaseAcquiredAtUtc } : {}),
		...(leaseExpiresAtUtc !== undefined ? { leaseExpiresAtUtc } : {}),
		...(row.last_failure_class !== undefined ? { lastFailureClass: row.last_failure_class } : {}),
		...(row.last_failure_code !== undefined ? { lastFailureCode: row.last_failure_code } : {}),
		...(lastFailureAtUtc !== undefined ? { lastFailureAtUtc } : {}),
		...(retryNotBeforeUtc !== undefined ? { retryNotBeforeUtc } : {}),
		...(updatedAtUtc !== undefined ? { updatedAtUtc } : {}),
	};
}

function credentialView(row: SdkAuthCredentialView): AuthCredentialView {
	return {
		schemaVersion: "bb.auth.credential_summary.v1",
		accountId: row.account_id,
		credentialRef: row.credential_id,
		providerId: row.provider_id,
		authSchemeId: authScheme(row.auth_scheme_id),
		credentialKind: credentialKind(row.credential_kind),
		...(row.alias ? { alias: row.alias } : {}),
		accountLabel: row.label,
		status: hasSupportedCredentialClassification(row) ? credentialStatus(row.status) : "quarantined",
		secretVersion: row.secret_version,
		...(row.source ? { source: row.source } : {}),
		updatedAtUtc: new Date(row.updated_at_ms).toISOString(),
		...(row.has_api_key !== undefined ? { hasApiKey: row.has_api_key } : {}),
		expiresAtUtc: utc(row.expires_at_ms),
		createdAtUtc: new Date(row.created_at_ms).toISOString(),
		...(row.refresh_state ? { refreshState: refreshState(row.refresh_state) } : {}),
	};
}

function providerView(item: SdkAuthProviderView): AuthProviderView {
	const availabilityReason = providerAvailabilityReason(item.availability_reason);
	return {
		providerId: item.provider_id,
		aliases: item.aliases,
		displayName: item.display_name,
		supportTier: providerSupportTier(item.support_tier),
		authOwner: providerAuthOwner(item.auth_owner),
		available: item.available,
		...(availabilityReason !== undefined ? { availabilityReason } : {}),
		authSchemes: providerAuthSchemes(item.auth_schemes),
		loginAvailable: item.login_available === true,
		oauthFlows: providerOAuthFlows(item.oauth_flows),
		modelDiscovery: providerModelDiscovery(item.model_discovery),
		...(item.runtime_id ? { runtimeId: item.runtime_id } : {}),
		...(item.compatible_protocol ? { compatibleProtocol: item.compatible_protocol } : {}),
		...(item.base_url ? { baseUrl: item.base_url } : {}),
	};
}

function loginStatus(status: string): AuthLoginStatus {
	switch (status) {
		case "pending":
		case "awaiting_input":
		case "completed":
		case "cancelled":
		case "failed":
		case "unavailable":
			return status;
		default:
			return "unavailable";
	}
}

function safeScalar(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const normalized = value.replaceAll(/\s+/g, " ").trim();
	return normalized ? normalized.slice(0, 240) : fallback;
}

function loginSession(item: SdkAuthLoginSession): AuthLoginSession {
	const status = loginStatus(item.status);
	const authorizeUrl = item.authorization_url?.trim() || undefined;
	const redirectUri = item.redirect_uri?.trim() || undefined;
	const flowId = item.flow_id?.trim() || undefined;
	const flowKind = item.flow_kind === "browser" || item.flow_kind === "device" ? item.flow_kind : undefined;
	const userCode = item.user_code?.trim() || undefined;
	const instructions = item.instructions?.trim() || undefined;
	const createdAtUtc = optionalUtc(item.created_at_ms);
	const updatedAtUtc = optionalUtc(item.updated_at_ms);
	const waitingForInput = status === "pending" || status === "awaiting_input";
	const prompt =
		waitingForInput && flowKind !== "device" && authorizeUrl
			? "Paste the full callback URL from your browser, then press Enter."
			: undefined;
	const problem = item.problem;
	const unknownStatus = status === "unavailable" && item.status !== "unavailable";
	return {
		loginSessionId: item.login_session_id,
		providerId: item.provider_id,
		status,
		...(authorizeUrl ? { authorizeUrl } : {}),
		...(redirectUri ? { redirectUri } : {}),
		...(flowId ? { flowId } : {}),
		...(flowKind ? { flowKind } : {}),
		...(createdAtUtc !== undefined ? { createdAtUtc } : {}),
		...(updatedAtUtc !== undefined ? { updatedAtUtc } : {}),
		...(userCode ? { userCode } : {}),
		...(instructions ? { instructions } : {}),
		...(prompt ? { prompt } : {}),
		...(item.credential ? { credential: credentialView(item.credential) } : {}),
		...(problem
			? {
					problem: {
						code: safeScalar(problem.code, "provider_auth_error"),
						message: safeScalar(problem.message, "Provider authentication failed"),
					},
				}
			: unknownStatus
				? {
						problem: {
							code: "unsupported_login_status",
							message: "The provider returned an unsupported login state.",
						},
					}
				: {}),
	};
}

function providerAuthError(error: unknown, nextAction: string): ProviderAuthError {
	if (error instanceof ProviderAuthError) return error;
	if (error instanceof ApiError) {
		const message =
			error.status === 400
				? "The provider authentication request was rejected."
				: error.status === 403
					? "The provider authentication request was forbidden."
					: error.status >= 500
						? "The provider authentication service is unavailable."
						: "The provider authentication request failed.";
		return new ProviderAuthError({
			code: error.status === 403 ? "provider_auth_forbidden" : `provider_auth_http_${error.status}`,
			message,
			status: error.status,
			nextAction,
		});
	}
	return new ProviderAuthError({
		code: "provider_auth_transport_failed",
		message: "Provider authentication request failed.",
		nextAction,
	});
}

async function brokerCall<T>(nextAction: string, call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (error) {
		throw providerAuthError(error, nextAction);
	}
}

/** Maps the generated BreadBoard SDK auth client to the product UI port. */
export function createBreadboardProviderAuthPort(client: BreadboardProviderAuthClient): ProviderAuthPort {
	return {
		async listProviders() {
			return brokerCall("Retry provider discovery.", async () => (await client.listProviders()).map(providerView));
		},
		async listCredentials(providerId) {
			return brokerCall("Retry account discovery.", async () =>
				(await client.listCredentials(providerId)).map(credentialView),
			);
		},
		async beginLogin(input: BeginAuthLogin) {
			return brokerCall("Choose another supported authentication method.", async () =>
				loginSession(
					await client.beginLogin({
						provider_id: input.providerId,
						...(input.authSchemeId ? { auth_scheme_id: input.authSchemeId } : {}),
						...(input.flow ? { flow: input.flow } : {}),
					}),
				),
			);
		},
		async getLogin(loginSessionId) {
			return brokerCall("Retry provider login.", async () => loginSession(await client.getLogin(loginSessionId)));
		},
		async completeLogin(input: CompleteAuthLogin) {
			const parsed = parseCallbackInput(input.redirectOrCode);
			return brokerCall("Restart provider login and verify the callback.", async () =>
				loginSession(
					await client.completeLogin({
						login_session_id: input.loginSessionId,
						...(parsed.code ? { code: parsed.code } : {}),
						...(parsed.state ? { state: parsed.state } : {}),
						...(input.accountLabel ? { account_label: input.accountLabel } : {}),
						...(input.alias ? { alias: input.alias } : {}),
					}),
				),
			);
		},
		async cancelLogin(loginSessionId) {
			const response = await brokerCall("Retry cancellation.", () => client.cancelLogin(loginSessionId));
			return {
				ok: response.ok,
				outcome: response.ok ? "cancelled" : "no_op",
				loginSessionId,
			};
		},
		async putApiKey(input: PutApiKeyInput) {
			return brokerCall("Verify the key and retry provider setup.", async () =>
				credentialView(
					await client.putApiKey(input.providerId, input.accountLabel, {
						api_key: input.apiKey,
						...(input.authSchemeId ? { auth_scheme_id: input.authSchemeId } : {}),
						...(input.alias ? { alias: input.alias } : {}),
						...(input.bindings ? { headers: input.bindings } : {}),
					}),
				),
			);
		},
		async logout(input: LogoutInput) {
			const response = await brokerCall("Reload the account list and retry logout.", () =>
				client.logout(input.credentialRef),
			);
			return {
				ok: response.ok,
				outcome: response.ok ? "disabled" : "no_op",
				credentialRef: input.credentialRef,
			};
		},
		async revoke(input: RevokeInput) {
			const response = await brokerCall("Reload the account list before retrying revoke.", () =>
				client.revoke(input.credentialRef),
			);
			return {
				ok: response.ok,
				outcome: response.ok ? "revoked" : "no_op",
				credentialRef: input.credentialRef,
			};
		},
	};
}
