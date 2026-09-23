import { beforeAll, describe, expect, it } from "bun:test";
import { LoginDialogComponent } from "@oh-my-pi/pi-tui/overlays/login-dialog";
import type { TUI } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { OAuthManualInputManager } from "@oh-my-pi/pi-coding-agent/modes/oauth-manual-input";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";

beforeAll(async () => {
	await initTheme();
});

type RuntimeHarness = {
	runtime: { ctx: InteractiveModeContext };
	getSelectorMode: () => "login" | "logout" | undefined;
	getSelectorProvider: () => string | undefined;
	getRevokeProvider: () => string | undefined;
};

const createRuntimeHarness = (manualInput: OAuthManualInputManager): RuntimeHarness => {
	let selectorMode: "login" | "logout" | undefined;
	let selectorProvider: string | undefined;
	let revokeProvider: string | undefined;
	const ctx = createInteractiveModeContext({
		oauthManualInput: manualInput,
		usesProviderAuthBroker: () => true,
		showOAuthSelector: async (mode: "login" | "logout", providerId?: string) => {
			selectorMode = mode;
			selectorProvider = providerId;
		},
		showProviderRevokeSelector: async (providerId?: string) => {
			revokeProvider = providerId;
		},
	});
	return {
		runtime: { ctx },
		getSelectorMode: () => selectorMode,
		getSelectorProvider: () => selectorProvider,
		getRevokeProvider: () => revokeProvider,
	};
};

describe("BreadBoard provider auth UI", () => {
	it("routes broker-only provider IDs without consulting the native catalog", async () => {
		const harness = createRuntimeHarness(new OAuthManualInputManager());

		const handled = await executeBuiltinSlashCommand("/login broker-only", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.getSelectorMode()).toBe("login");
		expect(harness.getSelectorProvider()).toBe("broker-only");
	});

	it("routes broker logout and confirmed revoke as distinct commands", async () => {
		const logoutHarness = createRuntimeHarness(new OAuthManualInputManager());
		const revokeHarness = createRuntimeHarness(new OAuthManualInputManager());

		const logoutHandled = await executeBuiltinSlashCommand("/logout broker-only", logoutHarness.runtime);
		const revokeHandled = await executeBuiltinSlashCommand("/revoke broker-only", revokeHarness.runtime);

		expect(logoutHandled).toBe(true);
		expect(logoutHarness.getSelectorMode()).toBe("logout");
		expect(logoutHarness.getSelectorProvider()).toBe("broker-only");
		expect(revokeHandled).toBe(true);
		expect(revokeHarness.getRevokeProvider()).toBe("broker-only");
	});

	it("masks API-key prompts and clears the submitted input", async () => {
		const secretCanary = "sk-dialog-secret-canary";
		const tui = { requestRender() {} } as unknown as TUI;
		const dialog = new LoginDialogComponent(tui, "broker-only", () => {}, "Broker Only");
		const submitted = dialog.showPrompt("API key:", undefined, { secret: true });

		for (const character of secretCanary) dialog.handleInput(character);
		expect(
			dialog
				.renderContent(80)
				.map(line => Bun.stripANSI(line))
				.join("\n"),
		).not.toContain(secretCanary);
		dialog.handleInput("\n");

		expect(await submitted).toBe(secretCanary);
		expect(
			dialog
				.renderContent(80)
				.map(line => Bun.stripANSI(line))
				.join("\n"),
		).not.toContain(secretCanary);
	});
});
