/**
 * BreadBoard-owned provider/auth boundary used by the fork UI.
 *
 * Every value crossing this seam is plain data. Credential summaries never
 * contain secret material; only the broker's execution path may receive it.
 */
export type AuthProviderFlow = "auto" | "browser_pkce" | "device" | "manual";
export type AuthCredentialKind = "oauth2" | "api_key";
export type AuthCredentialStatus = "active" | "disabled" | "revoked" | "reauthorization_required" | "quarantined";
export type AuthLoginStatus = "pending" | "awaiting_input" | "completed" | "cancelled" | "failed" | "unavailable";

export interface AuthProviderView {
	readonly providerId: string;
	readonly displayName: string;
	readonly available: boolean;
	readonly storeCredentialsAs?: string;
	readonly authSchemes: readonly string[];
	readonly loginAvailable: boolean;
	readonly oauthFlows?: readonly string[];
	readonly runtimeId?: string;
	readonly compatibleProtocol?: string;
	readonly baseUrl?: string;
}

export interface AuthCredentialView {
	readonly schemaVersion: "bb.auth.credential_summary.v1";
	readonly credentialRef: string;
	readonly accountId?: string;
	readonly providerId: string;
	readonly authSchemeId: string;
	readonly credentialKind: AuthCredentialKind;
	readonly accountLabel: string;
	readonly alias?: string;
	readonly status: AuthCredentialStatus;
	readonly source: string;
	readonly isDefault: boolean;
	readonly expiresAtUtc: string | null;
	readonly createdAtUtc: string;
	readonly updatedAtUtc?: string;
	readonly hasApiKey?: boolean;
	readonly lastUsedAtUtc: string | null;
}

export interface BeginAuthLogin {
	readonly providerId: string;
	readonly authSchemeId?: string;
	readonly flow?: AuthProviderFlow;
	readonly accountLabel?: string;
	readonly makeDefault?: boolean;
	readonly headless?: boolean;
}

export interface AuthLoginSession {
	readonly loginSessionId: string;
	readonly providerId: string;
	readonly status: AuthLoginStatus;
	readonly authorizeUrl?: string;
	readonly launchUrl?: string;
	readonly redirectUri?: string;
	readonly flowId?: string;
	readonly flowKind?: "browser" | "device";
	readonly userCode?: string;
	readonly instructions?: string;
	readonly prompt?: string;
	readonly problem?: { readonly code: string; readonly message: string };
	readonly credential?: AuthCredentialView;
}

export interface CompleteAuthLogin {
	readonly loginSessionId: string;
	readonly redirectOrCode: string;
	readonly accountLabel?: string;
	readonly alias?: string;
}

export interface PutApiKeyInput {
	readonly providerId: string;
	readonly accountLabel: string;
	readonly apiKey: string;
	readonly authSchemeId?: string;
	readonly alias?: string;
	readonly bindings?: Readonly<Record<string, string>>;
	readonly makeDefault?: boolean;
}

export interface LogoutInput {
	readonly credentialRef: string;
}

export interface RevokeInput {
	readonly credentialRef: string;
	readonly reason?: string;
}

export interface RevokeResult {
	readonly credentialRef: string;
	readonly revoked: boolean;
}

export interface ProviderAuthDataSource {
	listProviders(): Promise<ReadonlyArray<AuthProviderView>>;
	listCredentials(providerId?: string): Promise<ReadonlyArray<AuthCredentialView>>;
	listProvidersSync?(): ReadonlyArray<AuthProviderView>;
	listCredentialsSync?(providerId?: string): ReadonlyArray<AuthCredentialView>;
}

export interface ProviderAuthPort extends ProviderAuthDataSource {
	beginLogin(input: BeginAuthLogin): Promise<AuthLoginSession>;
	getLogin(loginSessionId: string): Promise<AuthLoginSession>;
	completeLogin(input: CompleteAuthLogin): Promise<AuthLoginSession>;
	cancelLogin(loginSessionId: string): Promise<void>;
	putApiKey(input: PutApiKeyInput): Promise<AuthCredentialView>;
	logout(input: LogoutInput): Promise<void>;
	revoke(input: RevokeInput): Promise<RevokeResult>;
}
