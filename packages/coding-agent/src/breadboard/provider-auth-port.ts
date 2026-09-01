/**
 * BreadBoard-owned provider/auth boundary used by the fork UI.
 *
 * Every value crossing this seam is plain data. Credential summaries never
 * contain secret material; only the broker's execution path may receive it.
 */
export const AUTH_SCHEME_IDS = ["api_key", "oauth2"] as const;
export type AuthSchemeId = (typeof AUTH_SCHEME_IDS)[number];
export type AuthProviderFlow = "browser" | "device";
export type AuthProviderSupportTier = "core" | "unsupported";
export type AuthProviderAuthOwner = "broker" | "provider";
export type AuthProviderAvailabilityReason = "provider_managed" | "missing_auth" | "unsupported";
export type AuthProviderModelDiscovery = "configured_only" | "unsupported";
export type AuthCredentialKind = "oauth2" | "api_key";
export type AuthCredentialStatus =
	| "active"
	| "disabled"
	| "revoked"
	| "reauthorization_required"
	| "quarantined";
export type AuthCredentialRefreshStatus = "idle" | "refreshing" | "failed" | "blocked" | "unknown";
export type AuthLoginStatus = "pending" | "awaiting_input" | "completed" | "cancelled" | "failed" | "unavailable";
export type AuthActionOutcome = "cancelled" | "disabled" | "revoked" | "no_op";

export interface AuthProviderView {
	readonly providerId: string;
	readonly aliases: readonly string[];
	readonly displayName: string;
	readonly supportTier: AuthProviderSupportTier;
	readonly authOwner: AuthProviderAuthOwner;
	readonly available: boolean;
	readonly availabilityReason?: AuthProviderAvailabilityReason | null;
	readonly authSchemes: readonly AuthSchemeId[];
	readonly loginAvailable: boolean;
	readonly oauthFlows: readonly AuthProviderFlow[];
	readonly modelDiscovery: AuthProviderModelDiscovery;
	readonly storeCredentialsAs?: string;
	readonly runtimeId?: string;
	readonly compatibleProtocol?: string;
	readonly baseUrl?: string;
}

export interface AuthCredentialRefreshState {
	readonly status: AuthCredentialRefreshStatus;
	readonly expectedSecretVersion?: number | null;
	readonly leaseAcquiredAtUtc?: string | null;
	readonly leaseExpiresAtUtc?: string | null;
	readonly lastFailureClass?: string | null;
	readonly lastFailureCode?: string | null;
	readonly lastFailureAtUtc?: string | null;
	readonly retryNotBeforeUtc?: string | null;
	readonly updatedAtUtc?: string | null;
}

export interface AuthCredentialView {
	readonly schemaVersion: "bb.auth.credential_summary.v1";
	readonly credentialRef: string;
	readonly accountId: string;
	readonly providerId: string;
	readonly authSchemeId: AuthSchemeId;
	readonly credentialKind: AuthCredentialKind;
	readonly accountLabel: string;
	readonly alias?: string;
	readonly status: AuthCredentialStatus;
	readonly source?: string;
	readonly secretVersion?: number;
	readonly expiresAtUtc: string | null;
	readonly createdAtUtc?: string;
	readonly updatedAtUtc?: string;
	readonly hasApiKey?: boolean;
	readonly refreshState?: AuthCredentialRefreshState;
}

export interface BeginAuthLogin {
	readonly providerId: string;
	readonly authSchemeId?: AuthSchemeId;
	readonly flow?: AuthProviderFlow;
}

export interface AuthLoginSession {
	readonly loginSessionId: string;
	readonly providerId: string;
	readonly status: AuthLoginStatus;
	readonly createdAtUtc?: string | null;
	readonly updatedAtUtc?: string | null;
	readonly authorizeUrl?: string;
	readonly redirectUri?: string;
	readonly flowId?: string;
	readonly flowKind?: AuthProviderFlow;
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
	readonly authSchemeId?: AuthSchemeId;
	readonly alias?: string;
	readonly bindings?: Readonly<Record<string, string>>;
}

export interface LogoutInput {
	readonly credentialRef: string;
}

export interface RevokeInput {
	readonly credentialRef: string;
}

export interface AuthActionResult {
	readonly ok: boolean;
	readonly outcome: AuthActionOutcome;
	readonly credentialRef?: string;
	readonly loginSessionId?: string;
}

export class ProviderAuthError extends Error {
	readonly code: string;
	readonly status?: number;
	readonly nextAction: string;

	constructor(input: { code: string; message: string; status?: number; nextAction: string }) {
		super(input.message);
		this.name = "ProviderAuthError";
		this.code = input.code;
		this.status = input.status;
		this.nextAction = input.nextAction;
	}
}

export interface ProviderAuthReadPort {
	listProviders(): Promise<ReadonlyArray<AuthProviderView>>;
	listCredentials(providerId?: string): Promise<ReadonlyArray<AuthCredentialView>>;
	listProvidersSync?(): ReadonlyArray<AuthProviderView>;
	listCredentialsSync?(providerId?: string): ReadonlyArray<AuthCredentialView>;
}

export interface ProviderAuthMutationPort {
	beginLogin(input: BeginAuthLogin): Promise<AuthLoginSession>;
	getLogin(loginSessionId: string): Promise<AuthLoginSession>;
	completeLogin(input: CompleteAuthLogin): Promise<AuthLoginSession>;
	cancelLogin(loginSessionId: string): Promise<AuthActionResult>;
	putApiKey(input: PutApiKeyInput): Promise<AuthCredentialView>;
	logout(input: LogoutInput): Promise<AuthActionResult>;
	revoke(input: RevokeInput): Promise<AuthActionResult>;
}

export interface ProviderAuthPort extends ProviderAuthReadPort, ProviderAuthMutationPort {}
