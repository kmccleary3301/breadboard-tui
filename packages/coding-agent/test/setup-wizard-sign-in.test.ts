import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { OAuthLoginCallbacks, OAuthProviderId } from "@oh-my-pi/pi-ai/oauth/types";
import type { ProviderAuthPort } from "@oh-my-pi/pi-coding-agent/breadboard/provider-auth-port";
import { SignInTab } from "@oh-my-pi/pi-coding-agent/modes/setup-wizard/scenes/sign-in";
import type { SetupSceneHost } from "@oh-my-pi/pi-coding-agent/modes/setup-wizard/scenes/types";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import type { Component } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("SignInTab", () => {
	it("keeps the OSC8 login link and manual-code prompt above clipped wizard rows", async () => {
		const url = `https://example.com/oauth/authorize?client_id=omp&redirect_uri=http%3A%2F%2Flocalhost%3A45454%2Fcallback&state=${"a".repeat(96)}`;
		const loginGate = Promise.withResolvers<void>();
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		let focusTarget: Component | undefined;
		const openedUrls: string[] = [];

		const authStorage = {
			has: (_providerId: string) => false,
			hasAuth: (_providerId: string) => false,
			getCredentialOrigin: (_providerId: string) => undefined,
			async login(_provider: OAuthProviderId, ctrl: OAuthLoginCallbacks): Promise<void> {
				ctrl.onAuth({ url });
				const prompt = ctrl.onManualCodeInput?.();
				await loginGate.promise;
				await prompt;
			},
		} as unknown as AuthStorage;

		const host = {
			ctx: {
				openInBrowser(openedUrl: string): void {
					openedUrls.push(openedUrl);
				},
				session: {
					modelRegistry: {
						authStorage,
						async refresh(): Promise<void> {},
					},
				},
			},
			requestRender(): void {},
			finish(): void {},
			setFocus(component: Component | null): void {
				focusTarget = component ?? undefined;
			},
			restoreFocus(): void {},
		} as unknown as SetupSceneHost;

		const tab = new SignInTab(host);
		try {
			for (const char of "anthropic") {
				tab.handleInput(char);
			}
			tab.handleInput("\n");

			const rendered = tab.render(36);
			const compact = rendered.map(line => Bun.stripANSI(line).trim()).join("");
			expect(compact).toContain(url);
			expect(compact).not.toContain("…");
			expect(rendered.join("\n")).toContain(`\x1b]8;;${url}\x07Open login URL\x1b]8;;\x07`);
			expect(openedUrls).toEqual([url]);
			expect(focusTarget).toBeDefined();
			focusTarget?.handleInput?.("\x1bc");
			expect(copySpy).toHaveBeenCalledTimes(2);
			expect(copySpy).toHaveBeenLastCalledWith(url);

			// On a ~24-row terminal the wizard body ends up ~8 rows; the OSC8
			// link, a plain URL row, and the focused input must survive that clip.
			const clippedBody = rendered.slice(0, 8).map(line => Bun.stripANSI(line).trim());
			const plainUrlIndex = clippedBody.findIndex(line => line.startsWith("https://example.com/oauth/authorize?"));
			const inputIndex = clippedBody.findIndex(line => line.startsWith(">"));
			expect(clippedBody.some(line => line.startsWith("Browser login: Open login URL"))).toBe(true);
			expect(plainUrlIndex).toBeGreaterThanOrEqual(0);
			expect(clippedBody).toContain("Paste the authorization code (or full redirect URL):");
			expect(inputIndex).toBeGreaterThanOrEqual(0);
			expect(plainUrlIndex).toBeLessThan(inputIndex);
		} finally {
			tab.dispose();
			loginGate.resolve();
			await loginGate.promise;
		}
	});

	it("copies the active login URL from the keyboard while the setup TUI owns selection", async () => {
		const url = "https://example.com/oauth/authorize?client_id=omp&state=copy";
		const loginGate = Promise.withResolvers<void>();
		const copySpy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);

		const authStorage = {
			has: (_providerId: string) => false,
			hasAuth: (_providerId: string) => false,
			getCredentialOrigin: (_providerId: string) => undefined,
			async login(_provider: OAuthProviderId, ctrl: OAuthLoginCallbacks): Promise<void> {
				ctrl.onAuth({ url });
				await loginGate.promise;
			},
		} as unknown as AuthStorage;

		const host = {
			ctx: {
				openInBrowser(): void {},
				session: {
					modelRegistry: {
						authStorage,
						async refresh(): Promise<void> {},
					},
				},
			},
			requestRender(): void {},
			finish(): void {},
			setFocus(): void {},
			restoreFocus(): void {},
		} as unknown as SetupSceneHost;

		const tab = new SignInTab(host);
		try {
			for (const char of "anthropic") {
				tab.handleInput(char);
			}
			tab.handleInput("\n");
			await Promise.resolve();
			expect(copySpy).toHaveBeenCalledTimes(1);

			tab.handleInput("\x1bc");
			await Promise.resolve();
			expect(copySpy).toHaveBeenCalledTimes(2);
			expect(copySpy).toHaveBeenLastCalledWith(url);
		} finally {
			tab.dispose();
			loginGate.resolve();
			await loginGate.promise;
		}
	});

	it("uses the broker login state machine and clears masked API-key input", async () => {
		const secretCanary = "sk-ant-setup-canary";
		const nativeCalls: string[] = [];
		const writes: unknown[] = [];
		const authStorage = {
			async login() {
				nativeCalls.push("login");
				throw new Error("native AuthStorage login must not run in BreadBoard mode");
			},
			setRuntimeApiKey() {
				nativeCalls.push("setRuntimeApiKey");
				throw new Error("native AuthStorage mutation must not run in BreadBoard mode");
			},
		} as unknown as AuthStorage;
		const port: ProviderAuthPort = {
			async listProviders() {
				return [
					{
						providerId: "anthropic",
						aliases: ["claude"],
						displayName: "Anthropic",
						supportTier: "core",
						authOwner: "broker",
						available: true,
						authSchemes: ["api_key"],
						loginAvailable: false,
						oauthFlows: [],
						modelDiscovery: "configured_only",
					},
				];
			},
			async listCredentials() {
				return [];
			},
			async beginLogin() {
				throw new Error("OAuth login must not run for an API-key provider");
			},
			async getLogin() {
				throw new Error("OAuth login must not run for an API-key provider");
			},
			async completeLogin() {
				throw new Error("OAuth login must not run for an API-key provider");
			},
			async cancelLogin(loginSessionId) {
				return { ok: true, outcome: "cancelled", loginSessionId };
			},
			async putApiKey(input) {
				writes.push(input);
				return {
					schemaVersion: "bb.auth.credential_summary.v1",
					credentialRef: "bbcred_anthropic_work",
					accountId: "bbacct_anthropic_work",
					providerId: input.providerId,
					authSchemeId: "api_key",
					credentialKind: "api_key",
					accountLabel: input.accountLabel,
					status: "active",
					source: "broker",
					expiresAtUtc: null,
				};
			},
			async logout(input) {
				return { ok: true, outcome: "disabled", credentialRef: input.credentialRef };
			},
			async revoke(input) {
				return { ok: true, outcome: "revoked", credentialRef: input.credentialRef };
			},
		};
		const focused: Component[] = [];
		const host = {
			providerAuthPort: port,
			ctx: {
				openInBrowser(): void {},
				session: { modelRegistry: { authStorage } },
			},
			requestRender(): void {},
			finish(): void {},
			setFocus(component: Component | null): void {
				if (component) focused.push(component);
			},
			restoreFocus(): void {},
		} as unknown as SetupSceneHost;
		const tab = new SignInTab(host);
		try {
			for (let pass = 0; pass < 4; pass++) await Promise.resolve();
			tab.handleInput("\n");
			for (let pass = 0; pass < 8 && focused.length < 1; pass++) await Promise.resolve();
			const labelInput = focused[0];
			if (!labelInput) throw new Error("Account label prompt did not receive focus");
			for (const character of "work") labelInput.handleInput?.(character);
			labelInput.handleInput?.("\n");
			for (let pass = 0; pass < 8 && focused.length < 2; pass++) await Promise.resolve();
			const secretInput = focused[1];
			if (!secretInput) throw new Error("API-key prompt did not receive focus");
			for (const character of secretCanary) secretInput.handleInput?.(character);
			expect(
				tab
					.render(80)
					.map(line => Bun.stripANSI(line))
					.join("\n"),
			).not.toContain(secretCanary);
			secretInput.handleInput?.("\n");
			for (let pass = 0; pass < 8 && writes.length === 0; pass++) await Promise.resolve();
			expect(writes).toEqual([
				{
					providerId: "anthropic",
					authSchemeId: "api_key",
					accountLabel: "work",
					apiKey: secretCanary,
				},
			]);
			expect(nativeCalls).toEqual([]);
			expect(
				tab
					.render(80)
					.map(line => Bun.stripANSI(line))
					.join("\n"),
			).not.toContain(secretCanary);

			for (let pass = 0; pass < 16 && tab.modal; pass++) await Promise.resolve();
			expect(tab.modal).toBe(false);
			for (let pass = 0; pass < 8; pass++) await Promise.resolve();
			tab.handleInput("\n");
			for (let pass = 0; pass < 8 && focused.length < 3; pass++) await Promise.resolve();
			if (focused.length < 3) throw new Error("Second account label prompt did not receive focus");
			for (const character of "personal") tab.handleInput(character);
			tab.handleInput("\n");
			for (let pass = 0; pass < 8 && focused.length < 4; pass++) await Promise.resolve();
			if (focused.length < 4) throw new Error("Second API-key prompt did not receive focus");
			for (const character of "sk-cancelled-setup-canary") tab.handleInput(character);
			tab.handleInput("\u001b");
			for (let pass = 0; pass < 8 && tab.modal; pass++) await Promise.resolve();
			const cancelledRender = tab
				.render(80)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(tab.modal).toBe(false);
			expect(writes).toHaveLength(1);
			expect(cancelledRender).toContain("Login cancelled.");
			expect(cancelledRender).not.toContain("sk-cancelled-setup-canary");
			expect(nativeCalls).toEqual([]);
		} finally {
			tab.dispose();
		}
	});
});
