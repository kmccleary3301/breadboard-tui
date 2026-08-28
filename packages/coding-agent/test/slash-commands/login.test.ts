import { describe, expect, it } from "bun:test";
import { OAuthManualInputManager } from "@oh-my-pi/pi-coding-agent/modes/oauth-manual-input";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

type RuntimeHarness = {
	runtime: { ctx: InteractiveModeContext };
	getStatus: () => string | undefined;
	getWarning: () => string | undefined;
	getSelectorMode: () => "login" | "logout" | undefined;
	getSelectorProvider: () => string | undefined;
	getRevokeProvider: () => string | undefined;
};

const createRuntimeHarness = (manualInput: OAuthManualInputManager, usesBroker = false): RuntimeHarness => {
	let statusMessage: string | undefined;
	let warningMessage: string | undefined;
	let selectorMode: "login" | "logout" | undefined;
	let selectorProvider: string | undefined;
	let revokeProvider: string | undefined;
	const ctx = {
		oauthManualInput: manualInput,
		editor: {
			setText: () => {},
		} as unknown as InteractiveModeContext["editor"],
		showStatus: (message: string) => {
			statusMessage = message;
		},
		showWarning: (message: string) => {
			warningMessage = message;
		},
		usesProviderAuthBroker: () => usesBroker,
		showOAuthSelector: async (mode: "login" | "logout", providerId?: string) => {
			selectorMode = mode;
			selectorProvider = providerId;
		},
		showProviderRevokeSelector: async (providerId?: string) => {
			revokeProvider = providerId;
		},
	} as InteractiveModeContext;

	return {
		runtime: {
			ctx,
		},
		getStatus: () => statusMessage,
		getWarning: () => warningMessage,
		getSelectorMode: () => selectorMode,
		getSelectorProvider: () => selectorProvider,
		getRevokeProvider: () => revokeProvider,
	};
};

describe("/login slash command", () => {
	it("submits manual callback URL without opening selector", async () => {
		const manualInput = new OAuthManualInputManager();
		const callbackUrl = "http://localhost:1455/auth/callback?code=abc&state=xyz";
		const pending = manualInput.waitForInput("openai-codex");
		const harness = createRuntimeHarness(manualInput);

		const handled = await executeBuiltinSlashCommand(`/login ${callbackUrl}`, harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getSelectorMode()).toBeUndefined();
		expect(harness.getStatus()).toBe("OAuth callback received; completing login…");
		expect(await pending).toBe(callbackUrl);
	});

	it("opens selector when no args are provided", async () => {
		const manualInput = new OAuthManualInputManager();
		const harness = createRuntimeHarness(manualInput);

		const handled = await executeBuiltinSlashCommand("/login", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getSelectorMode()).toBe("login");
	});

	it("routes /login kagi to direct provider login", async () => {
		const manualInput = new OAuthManualInputManager();
		const harness = createRuntimeHarness(manualInput);

		const handled = await executeBuiltinSlashCommand("/login kagi", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getSelectorMode()).toBe("login");
		expect(harness.getSelectorProvider()).toBe("kagi");
	});

	it("routes /login parallel to direct provider login", async () => {
		const manualInput = new OAuthManualInputManager();
		const harness = createRuntimeHarness(manualInput);

		const handled = await executeBuiltinSlashCommand("/login parallel", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getSelectorMode()).toBe("login");
		expect(harness.getSelectorProvider()).toBe("parallel");
	});

	it("warns when no pending login exists for manual callback", async () => {
		const manualInput = new OAuthManualInputManager();
		const harness = createRuntimeHarness(manualInput);

		const handled = await executeBuiltinSlashCommand("/login http://localhost/callback", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getSelectorMode()).toBeUndefined();
		expect(harness.getWarning()).toBe("No OAuth login is waiting for a manual callback.");
	});

	it("routes broker-only provider IDs without consulting the native catalog", async () => {
		const harness = createRuntimeHarness(new OAuthManualInputManager(), true);

		const loginHandled = await executeBuiltinSlashCommand("/login broker-only", harness.runtime);

		expect(loginHandled).toBe(true);
		expect(harness.getSelectorMode()).toBe("login");
		expect(harness.getSelectorProvider()).toBe("broker-only");
	});

	it("routes broker logout and confirmed revoke as distinct commands", async () => {
		const logoutHarness = createRuntimeHarness(new OAuthManualInputManager(), true);
		const revokeHarness = createRuntimeHarness(new OAuthManualInputManager(), true);

		const logoutHandled = await executeBuiltinSlashCommand("/logout broker-only", logoutHarness.runtime);
		const revokeHandled = await executeBuiltinSlashCommand("/revoke broker-only", revokeHarness.runtime);

		expect(logoutHandled).toBe(true);
		expect(logoutHarness.getSelectorMode()).toBe("logout");
		expect(logoutHarness.getSelectorProvider()).toBe("broker-only");
		expect(revokeHandled).toBe(true);
		expect(revokeHarness.getRevokeProvider()).toBe("broker-only");
	});
});
