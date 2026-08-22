import type {
	BreadboardClient,
	AuthCredentialView as SdkAuthCredentialView,
	AuthLoginSession as SdkAuthLoginSession,
	AuthProviderView as SdkAuthProviderView,
} from "@breadboard/sdk";
import type {
	AuthCredentialStatus,
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
function credentialStatus(value: string): AuthCredentialStatus {
	if (value === "disabled" || value === "revoked" || value === "reauthorization_required" || value === "quarantined") {
		return value;
	}
	return "active";
}

function credentialView(row: SdkAuthCredentialView): AuthCredentialView {
	const kind = row.credential_kind === "oauth2" ? "oauth2" : "api_key";
	return {
		schemaVersion: "bb.auth.credential_summary.v1",
		credentialRef: row.credential_id,
		providerId: row.provider_id,
		authSchemeId: row.auth_scheme_id,
		credentialKind: kind,
		accountLabel: row.label,
		status: credentialStatus(row.status),
		source: row.source ?? "broker",
		isDefault: false,
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
	return {
		loginSessionId: item.login_session_id,
		providerId: item.provider_id,
		status: normalizedStatus,
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
			return loginSession(await client.beginLogin({ provider_id: input.providerId }));
		},
		async getLogin(loginSessionId) {
			return loginSession(await client.getLogin(loginSessionId));
		},
		async completeLogin(input: CompleteAuthLogin) {
			return loginSession(
				await client.completeLogin({
					login_session_id: input.loginSessionId,
					authorization_code: input.redirectOrCode,
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
