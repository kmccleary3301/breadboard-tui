import { beforeAll, describe, expect, test } from "bun:test";
import { createBreadboardModelRolePort } from "../../src/breadboard/model-role-port";
import { createBreadboardProviderAuthPort } from "../../src/breadboard/provider-auth-adapter";
import type {
	AuthCredentialView,
	AuthLoginSession,
	AuthProviderView,
	ProviderAuthPort,
	RevokeResult,
} from "../../src/breadboard/provider-auth-port";
import { createNativeProviderAuthDataSource } from "../../src/modes/components/oauth-provider-data-source";
import { OAuthSelectorComponent } from "../../src/modes/components/oauth-selector";
import { SelectorController } from "../../src/modes/controllers/selector-controller";
import { initTheme } from "../../src/modes/theme/theme";
import type { InteractiveModeContext } from "../../src/modes/types";

beforeAll(async () => {
	await initTheme();
});

const credential: AuthCredentialView = {
	schemaVersion: "bb.auth.credential_summary.v1",
	credentialRef: "bbcred_openai_1",
	providerId: "openai",
	authSchemeId: "oauth2",
	credentialKind: "oauth2",
	accountLabel: "test@example.com",
	status: "active",
	source: "broker",
	isDefault: true,
	expiresAtUtc: null,
	createdAtUtc: "2026-08-20T00:00:00Z",
	lastUsedAtUtc: null,
};

const completedLogin: AuthLoginSession = {
	loginSessionId: "login_1",
	providerId: "openai",
	status: "completed",
	credential,
};

function providerPort(overrides: Partial<ProviderAuthPort> = {}): ProviderAuthPort {
	return {
		async listProviders(): Promise<ReadonlyArray<AuthProviderView>> {
			return [
				{
					providerId: "openai",
					displayName: "OpenAI",
					available: true,
					authSchemes: ["oauth2"],
					loginAvailable: true,
				},
			];
		},
		async listCredentials() {
			return [credential];
		},
		async beginLogin() {
			return completedLogin;
		},
		async getLogin() {
			return completedLogin;
		},
		async completeLogin() {
			return completedLogin;
		},
		async cancelLogin() {},
		async putApiKey() {
			return credential;
		},
		async logout() {},
		async revoke(): Promise<RevokeResult> {
			return { credentialRef: credential.credentialRef, revoked: true };
		},
		...overrides,
	};
}

function controllerContext(authStorage: Record<string, unknown>, statuses: string[]): InteractiveModeContext {
	const ui = {
		requestRender() {},
		setFocus() {},
	};
	const editorContainer = {
		clear() {},
		addChild() {},
		children: [],
	};
	return {
		ui,
		editorContainer,
		editor: {},
		showStatus(message: string) {
			statuses.push(message);
		},
		showError(message: string) {
			statuses.push(`error:${message}`);
		},
		present() {},
		session: { modelRegistry: { authStorage } },
	} as unknown as InteractiveModeContext;
}

describe("BreadBoard provider auth port integration", () => {
	test("engine-mode login calls the injected port and never mutates AuthStorage", async () => {
		const calls: string[] = [];
		const authStorage = {
			login: async () => {
				calls.push("authStorage.login");
				throw new Error("native AuthStorage must not run in BreadBoard mode");
			},
		};
		const statuses: string[] = [];
		const context = controllerContext(authStorage, statuses);
		const port = providerPort({
			async beginLogin(input) {
				calls.push(`beginLogin:${input.providerId}`);
				return completedLogin;
			},
		});
		const controller = new SelectorController(context, port);
		await controller.showOAuthSelector("login", "openai");
		expect(calls).toEqual(["beginLogin:openai"]);
		expect(statuses).toEqual(["Logging in to openai…"]);
	});

	test("engine-mode logout calls the injected port with a credential reference", async () => {
		const calls: string[] = [];
		const authStorage = {
			removeCredential: async () => {
				calls.push("authStorage.removeCredential");
				throw new Error("native AuthStorage must not run in BreadBoard mode");
			},
		};
		const statuses: string[] = [];
		const context = controllerContext(authStorage, statuses);
		const port = providerPort({
			async listCredentials(providerId) {
				calls.push(`listCredentials:${providerId}`);
				return [credential];
			},
			async logout(input) {
				calls.push(`logout:${input.credentialRef}`);
			},
		});
		const controller = new SelectorController(context, port);
		await controller.showOAuthSelector("logout", "openai");
		expect(calls).toEqual(["listCredentials:openai", `logout:${credential.credentialRef}`]);
		expect(statuses).toEqual(["Successfully logged out test@example.com from openai"]);
	});
	test("BreadBoard provider/status data source drives selector rows without the native catalog", async () => {
		const selected: string[] = [];
		const source: ProviderAuthPort = providerPort({
			async listProviders() {
				return [
					{
						providerId: "bb-custom",
						displayName: "BreadBoard Custom",
						available: true,
						authSchemes: ["api_key"],
						loginAvailable: false,
					},
				];
			},
			async listCredentials() {
				return [];
			},
		});
		const selector = new OAuthSelectorComponent(
			"login",
			source,
			providerId => selected.push(providerId),
			() => {},
		);
		await selector.ready;
		expect(selector.render(80).join("\n")).toContain("BreadBoard Custom");
		selector.handleInput("\n");
		expect(selected).toEqual([]);
	});

	test("SDK adapter preserves real 0.3.0 DTOs without secret-bearing summaries", async () => {
		const requests: unknown[] = [];
		const credentialRow = {
			account_id: "bbacct_work",
			credential_id: "bbcred_work",
			provider_id: "openai",
			auth_scheme_id: "api_key",
			label: "work",
			credential_kind: "api_key",
			status: "active",
			source: "broker",
			secret_version: 1,
			created_at_ms: 1,
			updated_at_ms: 2,
		};
		const client = {
			async listProviders() {
				return [
					{ provider_id: "openai", display_name: "OpenAI", auth_schemes: ["api_key"], login_available: false },
				];
			},
			async listCredentials() {
				return [credentialRow];
			},
			async beginLogin() {
				return { login_session_id: "login-1", provider_id: "openai", status: "unavailable" };
			},
			async getLogin() {
				return { login_session_id: "login-1", provider_id: "openai", status: "unavailable" };
			},
			async completeLogin() {
				return { login_session_id: "login-1", provider_id: "openai", status: "unavailable" };
			},
			async cancelLogin() {
				return { ok: true };
			},
			async putApiKey(providerId: string, accountLabel: string, input: unknown) {
				requests.push({ providerId, accountLabel, input });
				return credentialRow;
			},
			async logout() {
				return { ok: true };
			},
			async revoke() {
				return { ok: true };
			},
		};
		const port = createBreadboardProviderAuthPort(client);
		const rows = await port.listCredentials("openai");
		expect(rows).toMatchObject([{ providerId: "openai", credentialRef: "bbcred_work", accountLabel: "work" }]);
		const stored = await port.putApiKey({ providerId: "openai", accountLabel: "work", apiKey: "secret-value" });
		const rotated = await port.putApiKey({ providerId: "openai", accountLabel: "work", apiKey: "rotated-secret" });
		expect(stored).toMatchObject({ providerId: "openai", credentialRef: "bbcred_work" });
		expect(rotated.accountLabel).toBe(stored.accountLabel);
		expect(requests).toEqual([
			{ providerId: "openai", accountLabel: "work", input: { api_key: "secret-value" } },
			{ providerId: "openai", accountLabel: "work", input: { api_key: "rotated-secret" } },
		]);
		const rolePort = createBreadboardModelRolePort({
			async resolveModelRoles() {
				return {
					lock: { role: "default", provider_id: "openai", account_id: "bbacct_work" },
					lock_hash: "lock-static",
				};
			},
		});
		const firstLock = await rolePort.resolveModelRoles({ model_roles: { schema_version: "bb.model_roles.v1" } });
		const rotatedLock = await rolePort.resolveModelRoles({ model_roles: { schema_version: "bb.model_roles.v1" } });
		expect(rotatedLock.lock_hash).toBe(firstLock.lock_hash);
		expect(JSON.stringify(rows)).not.toContain("secret-value");
		expect(JSON.stringify(rows)).not.toContain("rotated-secret");
	});

	test("native data source reports credential summaries without exposing secret bytes", async () => {
		const authStorage = {
			getCredentialOrigin: () => ({ kind: "oauth" }),
			listStoredCredentials: () => [
				{
					id: 7,
					provider: "openai",
					disabledCause: null,
					credential: { type: "api_key", key: "super-secret", source: "login" },
				},
			],
		};
		const source = createNativeProviderAuthDataSource(authStorage as never);
		const rows = await source.listCredentials("openai");
		expect(rows).toMatchObject([
			{ providerId: "openai", credentialRef: "7", credentialKind: "api_key", status: "active" },
		]);
		expect(JSON.stringify(rows)).not.toContain("super-secret");
	});
});
