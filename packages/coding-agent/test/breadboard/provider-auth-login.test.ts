import { describe, expect, test } from "bun:test";
import { ApiError } from "@breadboard/sdk";
import { createBreadboardProviderAuthPort } from "../../src/breadboard/provider-auth-adapter";
import { authenticateProvider, type ProviderAuthLoginPresenter } from "../../src/breadboard/provider-auth-login";
import {
	type AuthCredentialView,
	type AuthProviderView,
	ProviderAuthError,
	type ProviderAuthPort,
} from "../../src/breadboard/provider-auth-port";

const credential: AuthCredentialView = {
	schemaVersion: "bb.auth.credential_summary.v1",
	credentialRef: "bbcred_work",
	accountId: "bbacct_work",
	providerId: "anthropic",
	authSchemeId: "oauth2",
	credentialKind: "oauth2",
	accountLabel: "work",
	status: "active",
	source: "broker",
	expiresAtUtc: null,
};

function provider(overrides: Partial<AuthProviderView> = {}): AuthProviderView {
	return {
		providerId: "anthropic",
		aliases: ["claude"],
		displayName: "Anthropic",
		supportTier: "core",
		authOwner: "broker",
		available: true,
		authSchemes: ["oauth2"],
		loginAvailable: true,
		oauthFlows: ["browser", "device"],
		modelDiscovery: "configured_only",
		...overrides,
	};
}

function authPort(overrides: Partial<ProviderAuthPort> = {}): ProviderAuthPort {
	return {
		async listProviders() {
			return [provider()];
		},
		async listCredentials() {
			return [];
		},
		async beginLogin() {
			return { loginSessionId: "login-1", providerId: "anthropic", status: "completed", credential };
		},
		async getLogin() {
			return { loginSessionId: "login-1", providerId: "anthropic", status: "completed", credential };
		},
		async completeLogin() {
			return { loginSessionId: "login-1", providerId: "anthropic", status: "completed", credential };
		},
		async cancelLogin(loginSessionId) {
			return { ok: true, outcome: "cancelled", loginSessionId };
		},
		async putApiKey() {
			return { ...credential, authSchemeId: "api_key", credentialKind: "api_key" };
		},
		async logout(input) {
			return { ok: true, outcome: "disabled", credentialRef: input.credentialRef };
		},
		async revoke(input) {
			return { ok: true, outcome: "revoked", credentialRef: input.credentialRef };
		},
		...overrides,
	};
}

function presenter(overrides: Partial<ProviderAuthLoginPresenter> = {}): ProviderAuthLoginPresenter {
	return {
		signal: new AbortController().signal,
		async selectAuthScheme(_provider, schemes) {
			return schemes[0] ?? "";
		},
		showAuthorization() {},
		async prompt() {
			return "";
		},
		showProgress() {},
		...overrides,
	};
}

describe("BreadBoard provider login state machine", () => {
	test("stores API keys only through a masked broker prompt", async () => {
		const secretCanary = "sk-ant-canary-never-render";
		const prompts: Array<{ message: string; secret: boolean }> = [];
		const responses = ["work", secretCanary];
		const writes: unknown[] = [];
		const port = authPort({
			async listProviders() {
				return [
					provider({
						authSchemes: ["api_key"],
						available: false,
						availabilityReason: "missing_auth",
						loginAvailable: false,
						oauthFlows: [],
					}),
				];
			},
			async putApiKey(input) {
				writes.push(input);
				return { ...credential, authSchemeId: "api_key", credentialKind: "api_key" };
			},
		});

		const result = await authenticateProvider(
			port,
			"claude",
			presenter({
				async prompt(input) {
					prompts.push({ message: input.message, secret: input.secret });
					return responses.shift() ?? "";
				},
			}),
		);

		expect(result.credentialKind).toBe("api_key");
		expect(prompts).toEqual([
			{ message: "Account label for Anthropic:", secret: false },
			{ message: "API key for Anthropic:", secret: true },
		]);
		expect(writes).toEqual([
			{
				providerId: "anthropic",
				authSchemeId: "api_key",
				accountLabel: "work",
				apiKey: secretCanary,
			},
		]);
		expect(JSON.stringify(prompts)).not.toContain(secretCanary);
	});

	test("does not report a late API-key result after cancellation", async () => {
		const abort = new AbortController();
		const putStarted = Promise.withResolvers<void>();
		const putResult = Promise.withResolvers<AuthCredentialView>();
		const responses = ["work", "sk-cancelled-canary"];
		const port = authPort({
			async listProviders() {
				return [
					provider({
						authSchemes: ["api_key"],
						loginAvailable: false,
						oauthFlows: [],
					}),
				];
			},
			async putApiKey() {
				putStarted.resolve();
				return putResult.promise;
			},
		});
		const login = authenticateProvider(
			port,
			"anthropic",
			presenter({
				signal: abort.signal,
				async prompt() {
					return responses.shift() ?? "";
				},
			}),
		);
		await putStarted.promise;
		abort.abort();
		putResult.resolve({ ...credential, authSchemeId: "api_key", credentialKind: "api_key" });

		await expect(login).rejects.toMatchObject({ code: "provider_auth_cancelled" });
	});

	test("completes browser callbacks through the broker", async () => {
		const completed: unknown[] = [];
		const shown: string[] = [];
		const port = authPort({
			async beginLogin() {
				return {
					loginSessionId: "login-browser",
					providerId: "anthropic",
					status: "awaiting_input",
					authorizeUrl: "https://auth.example/authorize",
					flowKind: "browser",
					prompt: "Paste callback",
				};
			},
			async completeLogin(input) {
				completed.push(input);
				return {
					loginSessionId: input.loginSessionId,
					providerId: "anthropic",
					status: "completed",
					credential,
				};
			},
		});

		await authenticateProvider(
			port,
			"anthropic",
			presenter({
				async selectOAuthFlow() {
					return "browser";
				},
				showAuthorization(session) {
					if (session.authorizeUrl) shown.push(session.authorizeUrl);
				},
				async prompt() {
					return "http://localhost/callback?code=code&state=state";
				},
			}),
		);

		expect(shown).toEqual(["https://auth.example/authorize"]);
		expect(completed).toEqual([
			{
				loginSessionId: "login-browser",
				redirectOrCode: "http://localhost/callback?code=code&state=state",
			},
		]);
	});

	test("polls device login until the broker reports success", async () => {
		let polls = 0;
		const progress: string[] = [];
		const port = authPort({
			async beginLogin() {
				return {
					loginSessionId: "login-device",
					providerId: "anthropic",
					status: "pending",
					flowKind: "device",
					userCode: "ABCD-EFGH",
				};
			},
			async getLogin() {
				polls += 1;
				return polls === 1
					? { loginSessionId: "login-device", providerId: "anthropic", status: "pending" }
					: { loginSessionId: "login-device", providerId: "anthropic", status: "completed", credential };
			},
		});

		const result = await authenticateProvider(
			port,
			"anthropic",
			presenter({
				async selectOAuthFlow() {
					return "device";
				},
				showProgress(message) {
					progress.push(message);
				},
			}),
			{ pollIntervalMs: 0, timeoutMs: 1_000 },
		);

		expect(result).toBe(credential);
		expect(polls).toBe(2);
		expect(progress).toHaveLength(2);
	});

	test("times out and cancels a pending device login once", async () => {
		const cancellations: string[] = [];
		const port = authPort({
			async beginLogin() {
				return {
					loginSessionId: "login-timeout",
					providerId: "anthropic",
					status: "pending",
					flowKind: "device",
				};
			},
			async cancelLogin(loginSessionId) {
				cancellations.push(loginSessionId);
				return { ok: true, outcome: "cancelled", loginSessionId };
			},
		});

		const login = authenticateProvider(
			port,
			"anthropic",
			presenter({
				async selectOAuthFlow() {
					return "device";
				},
			}),
			{ pollIntervalMs: 0, timeoutMs: 0 },
		);

		await expect(login).rejects.toMatchObject({ code: "provider_login_timeout" });
		expect(cancellations).toEqual(["login-timeout"]);
	});

	test("abort wins over a late callback completion and cancels once", async () => {
		const abort = new AbortController();
		const completion =
			Promise.withResolvers<ReturnType<ProviderAuthPort["completeLogin"]> extends Promise<infer T> ? T : never>();
		const completionStarted = Promise.withResolvers<void>();
		const cancellations: string[] = [];
		const port = authPort({
			async beginLogin() {
				return {
					loginSessionId: "login-race",
					providerId: "anthropic",
					status: "awaiting_input",
					flowKind: "browser",
					prompt: "Paste callback",
				};
			},
			async completeLogin() {
				completionStarted.resolve();
				return completion.promise;
			},
			async cancelLogin(loginSessionId) {
				cancellations.push(loginSessionId);
				return { ok: true, outcome: "cancelled", loginSessionId };
			},
		});
		const login = authenticateProvider(
			port,
			"anthropic",
			presenter({
				signal: abort.signal,
				async prompt() {
					return "callback";
				},
			}),
		);
		await completionStarted.promise;
		abort.abort();
		completion.resolve({
			loginSessionId: "login-race",
			providerId: "anthropic",
			status: "completed",
			credential,
		});

		await expect(login).rejects.toMatchObject({ code: "provider_auth_cancelled" });
		expect(cancellations).toEqual(["login-race"]);
	});

	test("does not promote provider-managed authentication into broker login", async () => {
		let began = false;
		const port = authPort({
			async listProviders() {
				return [
					provider({
						providerId: "codex",
						displayName: "Codex",
						authOwner: "provider",
						available: false,
						availabilityReason: "provider_managed",
					}),
				];
			},
			async beginLogin() {
				began = true;
				throw new Error("provider-managed login must not reach the broker");
			},
		});

		await expect(authenticateProvider(port, "codex", presenter())).rejects.toMatchObject({
			code: "provider_auth_unavailable",
			message: "Codex is unavailable for BreadBoard-managed login.",
			nextAction: "Use the provider's own login flow.",
		});
		expect(began).toBe(false);
	});
});

type SdkAuthClient = Parameters<typeof createBreadboardProviderAuthPort>[0];

function sdkClient(overrides: Partial<SdkAuthClient>): SdkAuthClient {
	return {
		async listProviders() {
			return [];
		},
		async listCredentials() {
			return [];
		},
		async beginLogin() {
			throw new Error("not used");
		},
		async getLogin() {
			throw new Error("not used");
		},
		async completeLogin() {
			throw new Error("not used");
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
		...overrides,
	};
}

describe("BreadBoard provider auth failures", () => {
	for (const status of [400, 403, 500]) {
		test(`maps ${status} without exposing response bodies`, async () => {
			const secretCanary = `secret-body-${status}`;
			const port = createBreadboardProviderAuthPort(
				sdkClient({
					async listProviders() {
						throw new ApiError("Provider request failed", status, { detail: secretCanary });
					},
				}),
			);
			let observed: ProviderAuthError | undefined;
			try {
				await port.listProviders();
			} catch (error) {
				if (error instanceof ProviderAuthError) observed = error;
			}
			expect(observed).toMatchObject({
				status,
				code: status === 403 ? "provider_auth_forbidden" : `provider_auth_http_${status}`,
			});
			expect(observed?.message).not.toContain(secretCanary);
			expect(observed?.nextAction).toBe("Retry provider discovery.");
		});
	}

	test("parses raw and query callback input into typed SDK requests", async () => {
		const requests: unknown[] = [];
		const port = createBreadboardProviderAuthPort(
			sdkClient({
				async completeLogin(input) {
					requests.push(input);
					throw new ApiError("State mismatch", 400);
				},
			}),
		);

		for (const redirectOrCode of ["raw-authorization-code#raw-state", "?code=query-code&state=query-state"]) {
			await expect(port.completeLogin({ loginSessionId: "login-callback", redirectOrCode })).rejects.toMatchObject({
				code: "provider_auth_http_400",
				nextAction: "Restart provider login and verify the callback.",
			});
		}

		expect(requests).toEqual([
			{ login_session_id: "login-callback", code: "raw-authorization-code", state: "raw-state" },
			{ login_session_id: "login-callback", code: "query-code", state: "query-state" },
		]);
	});

	test("reports state mismatch without exposing the broker response body", async () => {
		const secretCanary = "state-mismatch-secret-body";
		const port = createBreadboardProviderAuthPort(
			sdkClient({
				async completeLogin() {
					throw new ApiError("State mismatch", 400, { detail: secretCanary });
				},
			}),
		);
		let observed: ProviderAuthError | undefined;
		try {
			await port.completeLogin({
				loginSessionId: "login-state",
				redirectOrCode: "http://localhost/callback?code=code&state=wrong",
			});
		} catch (error) {
			if (error instanceof ProviderAuthError) observed = error;
		}

		expect(observed).toMatchObject({
			code: "provider_auth_http_400",
			status: 400,
			nextAction: "Restart provider login and verify the callback.",
		});
		expect(observed?.message).not.toContain(secretCanary);
	});
});
