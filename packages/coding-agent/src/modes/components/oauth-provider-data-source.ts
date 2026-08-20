import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthProviderInfo } from "@oh-my-pi/pi-ai/oauth/types";
import type { AuthCredentialView, AuthProviderView, ProviderAuthDataSource } from "../../breadboard/provider-auth-port";
import type { AuthStorage, StoredAuthCredential } from "../../session/auth-storage";

function providerView(provider: OAuthProviderInfo): AuthProviderView {
	return {
		providerId: provider.id,
		displayName: provider.name,
		storeCredentialsAs: provider.storeCredentialsAs,
		available: provider.available,
		authSchemes: ["oauth2"],
		loginAvailable: provider.available,
	};
}

function credentialView(row: StoredAuthCredential, authStorage: AuthStorage): AuthCredentialView {
	const credential = row.credential;
	const isOAuth = credential.type === "oauth";
	const expiresAtUtc =
		isOAuth && Number.isFinite(credential.expires) ? new Date(credential.expires).toISOString() : null;
	return {
		schemaVersion: "bb.auth.credential_summary.v1",
		credentialRef: String(row.id),
		providerId: row.provider,
		authSchemeId: isOAuth ? "oauth2" : "api_key",
		credentialKind: isOAuth ? "oauth2" : "api_key",
		accountLabel: isOAuth
			? (credential.email ?? credential.accountId ?? credential.orgName ?? `OAuth credential #${row.id}`)
			: `API key #${row.id}`,
		status: row.disabledCause ? "disabled" : "active",
		source: isOAuth ? "oauth" : (credential.source ?? "login"),
		isDefault: authStorage.getCredentialOrigin(row.provider)?.kind === (isOAuth ? "oauth" : "api_key"),
		expiresAtUtc,
		createdAtUtc: "",
		lastUsedAtUtc: null,
	};
}

/** Adapts native OMP storage to the same read-only provider data source as BreadBoard. */
export function createNativeProviderAuthDataSource(authStorage: AuthStorage): ProviderAuthDataSource {
	return {
		listProvidersSync() {
			return getOAuthProviders().map(providerView);
		},
		listCredentialsSync(providerId) {
			return authStorage.listStoredCredentials?.(providerId).map(row => credentialView(row, authStorage)) ?? [];
		},
		async listProviders() {
			return getOAuthProviders().map(providerView);
		},
		async listCredentials(providerId) {
			return authStorage.listStoredCredentials?.(providerId).map(row => credentialView(row, authStorage)) ?? [];
		},
	};
}
