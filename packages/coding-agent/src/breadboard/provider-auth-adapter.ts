import type {
	BreadboardClient,
	AuthCredentialView as SdkAuthCredentialView,
	AuthLoginSession as SdkAuthLoginSession,
	AuthProviderView as SdkAuthProviderView,
} from "@breadboard/sdk";
import { parseCallbackInput } from "@oh-my-pi/pi-ai/oauth/callback-server";
import type {
	AuthCredentialView,
	AuthLoginSession,
	AuthProviderView,
	BeginAuthLogin,
	CompleteAuthLogin,
	LogoutInput,
	ProviderAuthPort,
	PutApiKeyInput,
	RevokeInput,
	RevokeResult,
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
function credentialView(row: SdkAuthCredentialView): AuthCredentialView {
	const kind = row.credential_kind || "api_key";
	return {
		schemaVersion: "bb.auth.credential_summary.v1",
		accountId: row.account_id,
		credentialRef: row.credential_id,
		providerId: row.provider_id,
		authSchemeId: row.auth_scheme_id,
		credentialKind: kind,
		...(row.alias ? { alias: row.alias } : {}),
		accountLabel: row.label,
		status: row.status,
		source: row.source ?? "broker",
		isDefault: false,
		updatedAtUtc: new Date(row.updated_at_ms).toISOString(),
		...(row.has_api_key !== undefined ? { hasApiKey: row.has_api_key } : {}),
		expiresAtUtc: row.expires_at_ms == null ? null : new Date(row.expires_at_ms).toISOString(),
		createdAtUtc: new Date(row.created_at_ms).toISOString(),
		lastUsedAtUtc: null,
	};
}

function providerView(item: SdkAuthProviderView): AuthProviderView {
	return {
		providerId: item.provider_id,
		displayName: item.display_name,
		available: true,
		authSchemes: item.auth_schemes,
		loginAvailable: item.login_available === true,
		...(item.oauth_flows ? { oauthFlows: item.oauth_flows } : {}),
		...(item.runtime_id ? { runtimeId: item.runtime_id } : {}),
		...(item.compatible_protocol ? { compatibleProtocol: item.compatible_protocol } : {}),
		...(item.base_url ? { baseUrl: item.base_url } : {}),
	};
}

function loginSession(item: SdkAuthLoginSession): AuthLoginSession {
	const status = item.status;
	const normalizedStatus =
		status === "completed" ||
		status === "cancelled" ||
		status === "failed" ||
		status === "awaiting_input" ||
		status === "unavailable"
			? status
			: "pending";
	const problem = item.problem;
	const authorizeUrl = item.authorization_url?.trim() || undefined;
	const redirectUri = item.redirect_uri?.trim() || undefined;
	const flowId = item.flow_id?.trim() || undefined;
	const flowKind = item.flow_kind === "browser" || item.flow_kind === "device" ? item.flow_kind : undefined;
	const userCode = item.user_code?.trim() || undefined;
	const instructions = [item.instructions?.trim(), userCode ? `Authorization code: ${userCode}` : undefined]
		.filter((value): value is string => !!value)
		.join("\n");
	const waitingForInput = normalizedStatus === "pending" || normalizedStatus === "awaiting_input";
	const prompt = waitingForInput
		? flowKind === "device"
			? "Complete authorization in your browser, then press Enter."
			: authorizeUrl
				? "Paste the full callback URL from your browser, then press Enter."
				: undefined
		: undefined;
	return {
		loginSessionId: item.login_session_id,
		providerId: item.provider_id,
		status: normalizedStatus,
		...(authorizeUrl ? { authorizeUrl } : {}),
		...(redirectUri ? { redirectUri } : {}),
		...(flowId ? { flowId } : {}),
		...(flowKind ? { flowKind } : {}),
		...(userCode ? { userCode } : {}),
		...(instructions ? { instructions } : {}),
		...(prompt ? { prompt } : {}),
		...(item.credential ? { credential: credentialView(item.credential) } : {}),
		...(problem
			? {
					problem: {
						code: String(problem.code ?? "provider_auth_error"),
						message: String(problem.message ?? "Provider authentication failed"),
					},
				}
			: {}),
	};
}

/** Maps the real @breadboard/sdk 0.3.0 wire client to the fork UI port. */
export function createBreadboardProviderAuthPort(client: BreadboardProviderAuthClient): ProviderAuthPort {
	return {
		async listProviders() {
			return (await client.listProviders()).map(providerView);
		},
		async listCredentials(providerId) {
			return (await client.listCredentials(providerId)).map(credentialView);
		},
		async beginLogin(input: BeginAuthLogin) {
			const flow =
				input.flow === "device"
					? "device"
					: input.flow === "manual" || input.flow === "browser_pkce"
						? "browser"
						: undefined;
			return loginSession(
				await client.beginLogin({
					provider_id: input.providerId,
					...(input.authSchemeId ? { auth_scheme_id: input.authSchemeId } : {}),
					...(flow ? { flow } : {}),
				}),
			);
		},
		async getLogin(loginSessionId) {
			return loginSession(await client.getLogin(loginSessionId));
		},
		async completeLogin(input: CompleteAuthLogin) {
			const parsed = parseCallbackInput(input.redirectOrCode);
			return loginSession(
				await client.completeLogin({
					login_session_id: input.loginSessionId,
					...(parsed.code ? { code: parsed.code } : {}),
					...(parsed.state ? { state: parsed.state } : {}),
					...(input.accountLabel ? { account_label: input.accountLabel } : {}),
					...(input.alias ? { alias: input.alias } : {}),
				}),
			);
		},
		async cancelLogin(loginSessionId) {
			await client.cancelLogin(loginSessionId);
		},
		async putApiKey(input: PutApiKeyInput) {
			const sdkInput = {
				api_key: input.apiKey,
				...(input.authSchemeId ? { auth_scheme_id: input.authSchemeId } : {}),
				...(input.alias ? { alias: input.alias } : {}),
				...(input.bindings ? { headers: input.bindings } : {}),
			};
			return credentialView(await client.putApiKey(input.providerId, input.accountLabel, sdkInput));
		},
		async logout(input: LogoutInput) {
			await client.logout(input.credentialRef);
		},
		async revoke(input: RevokeInput): Promise<RevokeResult> {
			const response = await client.revoke(input.credentialRef);
			return { credentialRef: input.credentialRef, revoked: response.ok };
		},
	};
}
