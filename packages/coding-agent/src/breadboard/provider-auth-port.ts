/**
 * BreadBoard-owned provider/auth boundary used by the fork UI.
 *
 * Every value crossing this seam is plain data. Credential summaries never
 * contain secret material; only the broker's execution path may receive it.
 */
export type AuthProviderFlow = "browser" | "device";
export type AuthCredentialKind = "oauth2" | "api_key" | (string & {});
export type AuthCredentialStatus =
	| "active"
	| "disabled"
	| "revoked"
	| "reauthorization_required"
	| "quarantined"
	| (string & {});
export type AuthLoginStatus = "pending" | "awaiting_input" | "completed" | "cancelled" | "failed" | "unavailable";
export type AuthActionOutcome = "cancelled" | "disabled" | "revoked" | "no_op";

export interface AuthProviderView {
	readonly providerId: string;
	readonly aliases: readonly string[];
	readonly displayName: string;
	readonly supportTier: string;
	readonly authOwner: "broker" | "provider";
	readonly available: boolean;
	readonly availabilityReason?: "provider_managed" | "missing_auth" | null;
	readonly authSchemes: readonly string[];
	readonly loginAvailable: boolean;
	readonly oauthFlows: readonly string[];
	readonly modelDiscovery: "configured_only";
	readonly storeCredentialsAs?: string;
	readonly runtimeId?: string;
	readonly compatibleProtocol?: string;
	readonly baseUrl?: string;
}

export interface AuthCredentialRefreshState {
	readonly status: string;
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
	readonly authSchemeId: string;
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
	readonly authSchemeId?: string;
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
	readonly authSchemeId?: string;
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
	cancelLogin(loginSessionId: string): Promise<AuthActionResult>;
	putApiKey(input: PutApiKeyInput): Promise<AuthCredentialView>;
	logout(input: LogoutInput): Promise<AuthActionResult>;
	revoke(input: RevokeInput): Promise<AuthActionResult>;
}
