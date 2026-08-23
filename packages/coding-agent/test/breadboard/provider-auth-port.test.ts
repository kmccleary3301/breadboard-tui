import { afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
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
import * as openModule from "../../src/utils/open";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
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

function controllerContext(
	authStorage: Record<string, unknown>,
	statuses: string[],
	onFocus?: (component: unknown) => void,
): InteractiveModeContext {
	const ui = {
		requestRender() {},
		setFocus(component: unknown) {
			onFocus?.(component);
		},
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

	test("SDK adapter preserves browser launch metadata and parses callback completion", async () => {
		let beginRequest: unknown;
		let completeRequest: unknown;
		const credentialRow = {
			account_id: "bbacct_codex",
			credential_id: "bbcred_codex",
			provider_id: "codex",
			auth_scheme_id: "oauth2",
			label: "user@example.com",
			credential_kind: "oauth2",
			status: "active",
			source: "broker",
			secret_version: 1,
			created_at_ms: 1,
			updated_at_ms: 2,
		};
		const client = {
			async listProviders() {
				return [];
			},
			async listCredentials() {
				return [];
			},
			async beginLogin(input: unknown) {
				beginRequest = input;
				return {
					login_session_id: "login-browser",
					provider_id: "codex",
					status: "pending",
					authorization_url: "https://auth.example/authorize?state=csrf-state",
					redirect_uri: "http://localhost:1455/auth/callback",
					flow_id: "openai-codex",
					flow_kind: "browser",
					instructions: "Complete login in your browser.",
				};
			},
			async getLogin() {
				throw new Error("not used");
			},
			async completeLogin(input: unknown) {
				completeRequest = input;
				return {
					login_session_id: "login-browser",
					provider_id: "codex",
					status: "completed",
					credential: credentialRow,
				};
			},
			async cancelLogin() {
				return { ok: true };
			},
			async putApiKey() {
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

		const started = await port.beginLogin({ providerId: "codex", flow: "manual" });
		expect(beginRequest).toEqual({ provider_id: "codex", flow: "browser" });
		expect(started).toMatchObject({
			status: "pending",
			authorizeUrl: "https://auth.example/authorize?state=csrf-state",
			instructions: "Complete login in your browser.",
			prompt: "Paste the full callback URL from your browser, then press Enter.",
		});

		const completed = await port.completeLogin({
			loginSessionId: started.loginSessionId,
			redirectOrCode: "http://localhost:1455/auth/callback?code=authorization-code&state=csrf-state",
		});
		expect(completeRequest).toEqual({
			login_session_id: "login-browser",
			code: "authorization-code",
			state: "csrf-state",
		});
		expect(completed).toMatchObject({
			status: "completed",
			credential: { credentialRef: "bbcred_codex", accountLabel: "user@example.com" },
		});
		expect(JSON.stringify(started)).not.toContain("authorization-code");
		expect(JSON.stringify(completed)).not.toContain("authorization-code");
	});

	test("SDK adapter carries pending device authorization through explicit completion", async () => {
		const requests: unknown[] = [];
		const client = {
			async listProviders() {
				return [];
			},
			async listCredentials() {
				return [];
			},
			async beginLogin(input: unknown) {
				requests.push(input);
				return {
					login_session_id: "login-device",
					provider_id: "codex",
					status: "pending",
					authorization_url: "https://auth.example/device",
					flow_kind: "device",
					user_code: "ABCD-EFGH",
					instructions: "Enter the code in your browser.",
				};
			},
			async getLogin() {
				throw new Error("not used");
			},
			async completeLogin(input: unknown) {
				requests.push(input);
				return {
					login_session_id: "login-device",
					provider_id: "codex",
					status: "completed",
					credential: {
						account_id: "bbacct_device",
						credential_id: "bbcred_device",
						provider_id: "codex",
						auth_scheme_id: "oauth2",
						label: "device-user",
						credential_kind: "oauth2",
						status: "active",
						source: "broker",
						secret_version: 1,
						created_at_ms: 1,
						updated_at_ms: 2,
					},
				};
			},
			async cancelLogin() {
				return { ok: true };
			},
			async putApiKey() {
				throw new Error("not used");
			},
			async logout() {
				return { ok: true };
			},
			async revoke() {
				return { ok: true };
			},
		};
		const port = createBreadboardProviderAuthPort(client);

		const started = await port.beginLogin({ providerId: "codex", authSchemeId: "oauth2", flow: "device" });
		expect(started).toMatchObject({
			flowKind: "device",
			userCode: "ABCD-EFGH",
			instructions: "Enter the code in your browser.\nAuthorization code: ABCD-EFGH",
			prompt: "Complete authorization in your browser, then press Enter.",
		});
		const completed = await port.completeLogin({ loginSessionId: started.loginSessionId, redirectOrCode: "" });
		expect(completed.status).toBe("completed");
		expect(requests).toEqual([
			{ provider_id: "codex", auth_scheme_id: "oauth2", flow: "device" },
			{ login_session_id: "login-device" },
		]);
	});

	test("pending browser login opens authorization and completes through the mounted prompt", async () => {
		const opened: string[] = [];
		const beginObserved = Promise.withResolvers<void>();
		vi.spyOn(openModule, "openPath").mockImplementation(url => opened.push(url));
		let focused:
			| {
					pasteText(text: string): void;
					handleInput(data: string): void;
			  }
			| undefined;
		const statuses: string[] = [];
		const context = controllerContext({}, statuses, component => {
			if (component && typeof component === "object" && "pasteText" in component && "handleInput" in component) {
				focused = component as typeof focused;
			}
		});
		const client = {
			async listProviders() {
				return [];
			},
			async listCredentials() {
				return [];
			},
			async beginLogin() {
				beginObserved.resolve();
				return {
					login_session_id: "login-pending",
					provider_id: "codex",
					status: "pending",
					authorization_url: "https://auth.example/authorize?state=csrf-state",
					flow_kind: "browser",
				};
			},
			async getLogin() {
				throw new Error("not used");
			},
			async completeLogin() {
				return {
					login_session_id: "login-pending",
					provider_id: "codex",
					status: "completed",
					credential: {
						account_id: "bbacct_codex",
						credential_id: "bbcred_codex",
						provider_id: "codex",
						auth_scheme_id: "oauth2",
						label: "user@example.com",
						credential_kind: "oauth2",
						status: "active",
						source: "broker",
						secret_version: 1,
						created_at_ms: 1,
						updated_at_ms: 2,
					},
				};
			},
			async cancelLogin() {
				return { ok: true };
			},
			async putApiKey() {
				throw new Error("not used");
			},
			async logout() {
				return { ok: true };
			},
			async revoke() {
				return { ok: true };
			},
		};
		const controller = new SelectorController(context, createBreadboardProviderAuthPort(client));

		const login = controller.showOAuthSelector("login", "codex");
		for (let pass = 0; pass < 8 && !focused; pass++) await Promise.resolve();
		if (!focused) throw new Error("Login prompt did not receive focus");
		await beginObserved.promise;
		for (let pass = 0; pass < 4; pass++) await Promise.resolve();
		focused.pasteText("http://localhost:1455/auth/callback?code=auth-code&state=csrf-state");
		focused.handleInput("\n");
		await login;
		expect(opened).toEqual(["https://auth.example/authorize?state=csrf-state"]);
		expect(statuses).toEqual(["Logging in to codex…"]);
	});

	test("Escape cancels a pending broker login and restores the editor", async () => {
		const beginObserved = Promise.withResolvers<void>();
		const cancelCalls: string[] = [];
		vi.spyOn(openModule, "openPath").mockImplementation(() => {});
		let focused: { handleInput(data: string): void } | undefined;
		const statuses: string[] = [];
		const context = controllerContext({}, statuses, component => {
			if (component && typeof component === "object" && "handleInput" in component) {
				focused = component as { handleInput(data: string): void };
			}
		});
		const port = providerPort({
			async beginLogin() {
				beginObserved.resolve();
				return {
					loginSessionId: "login-cancel",
					providerId: "codex",
					status: "pending",
					authorizeUrl: "https://auth.example/authorize",
					prompt: "Paste the callback URL.",
				};
			},
			async cancelLogin(loginSessionId) {
				cancelCalls.push(loginSessionId);
			},
			async completeLogin() {
				throw new Error("cancelled login must not complete");
			},
		});
		const controller = new SelectorController(context, port);

		const login = controller.showOAuthSelector("login", "codex");
		for (let pass = 0; pass < 8 && !focused; pass++) await Promise.resolve();
		if (!focused) throw new Error("Login prompt did not receive focus");
		await beginObserved.promise;
		for (let pass = 0; pass < 4; pass++) await Promise.resolve();
		focused.handleInput("\u001b");
		await login;
		for (let pass = 0; pass < 4; pass++) await Promise.resolve();

		expect(cancelCalls).toEqual(["login-cancel"]);
		expect(statuses).toEqual(["Logging in to codex…", "Login cancelled"]);
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
