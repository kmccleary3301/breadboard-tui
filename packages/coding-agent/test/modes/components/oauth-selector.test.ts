import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type {
	AuthCredentialView,
	ProviderAuthReadPort,
} from "@oh-my-pi/pi-coding-agent/breadboard/provider-auth-port";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { OAuthSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/oauth-selector";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function providerDataSource(storedProviders: readonly string[] = []): ProviderAuthReadPort {
	return {
		async listProviders() {
			return getOAuthProviders().map(provider => ({
				providerId: provider.id,
				aliases: [],
				displayName: provider.name,
				storeCredentialsAs: provider.storeCredentialsAs,
				supportTier: "core",
				authOwner: "provider",
				available: provider.available,
				authSchemes: ["oauth2"],
				loginAvailable: provider.available,
				oauthFlows: [],
				modelDiscovery: "configured_only",
			}));
		},
		async listCredentials() {
			return storedProviders.map(
				providerId =>
					({
						schemaVersion: "bb.auth.credential_summary.v1",
						credentialRef: `${providerId}-credential`,
						accountId: `${providerId}-account`,
						providerId,
						authSchemeId: "oauth2",
						credentialKind: "oauth2",
						accountLabel: `${providerId} account`,
						status: "active",
						source: "oauth",
						expiresAtUtc: null,
						createdAtUtc: "",
					}) satisfies AuthCredentialView,
			);
		},
	};
}

describe("OAuthSelectorComponent", () => {
	it("fuzzy-filters overflowing provider lists from typed input", async () => {
		const providers = getOAuthProviders();
		expect(providers.length).toBeGreaterThan(10);
		const target =
			providers.find(provider => provider.available && provider.id === "vllm") ??
			providers.find(provider => provider.available) ??
			providers[0];
		expect(target).toBeDefined();
		if (!target) return;

		const selected: string[] = [];
		const component = new OAuthSelectorComponent(
			"login",
			providerDataSource(),
			providerId => selected.push(providerId),
			() => {},
		);
		await component.ready;

		for (const char of target.id) {
			component.handleInput(char);
		}

		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain(target.name);
		expect(rendered).toContain(`Search: ${target.id}`);

		component.handleInput("\n");
		expect(selected).toEqual([target.id]);
	});
	it("does not offer env-only providers as logout targets", async () => {
		const selected: string[] = [];
		const component = new OAuthSelectorComponent(
			"logout",
			providerDataSource(),
			providerId => selected.push(providerId),
			() => {},
		);
		await component.ready;

		for (const char of "opencode-go") {
			component.handleInput(char);
		}

		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("No stored provider credentials to log out");

		component.handleInput("\n");
		expect(selected).toEqual([]);
	});

	it("offers stored providers as logout targets", async () => {
		const selected: string[] = [];
		const component = new OAuthSelectorComponent(
			"logout",
			providerDataSource(["opencode-go"]),
			providerId => selected.push(providerId),
			() => {},
		);
		await component.ready;

		for (const char of "opencode-go") {
			component.handleInput(char);
		}

		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("OpenCode Go");
		expect(rendered).toContain("logged in");

		component.handleInput("\n");
		expect(selected).toEqual(["opencode-go"]);
	});

	describe("disabledProviders", () => {
		afterEach(() => {
			resetSettingsForTest();
		});

		it("hides disabled providers from the login list even when searched", async () => {
			const providers = getOAuthProviders();
			const victim =
				providers.find(provider => provider.available && provider.id === "vllm") ??
				providers.find(provider => provider.available) ??
				providers[0];
			expect(victim).toBeDefined();
			if (!victim) return;

			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { disabledProviders: [victim.id] } });

			const component = new OAuthSelectorComponent(
				"login",
				providerDataSource(),
				() => {},
				() => {},
			);
			await component.ready;
			for (const char of victim.id) {
				component.handleInput(char);
			}
			const rendered = component
				.render(80)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(rendered).not.toContain(victim.name);
		});

		it("hides alias logins whose storeCredentialsAs target is disabled", async () => {
			const alias = getOAuthProviders().find(provider => provider.storeCredentialsAs === "openai-codex");
			expect(alias).toBeDefined();
			if (!alias) return;
			expect(alias.id).not.toBe("openai-codex");

			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { disabledProviders: ["openai-codex"] } });

			const component = new OAuthSelectorComponent(
				"login",
				providerDataSource(),
				() => {},
				() => {},
			);
			await component.ready;
			for (const char of alias.id) {
				component.handleInput(char);
			}
			const rendered = component
				.render(80)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(rendered).not.toContain(alias.name);
		});

		it("keeps disabled providers as logout targets", async () => {
			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { disabledProviders: ["opencode-go"] } });

			const selected: string[] = [];
			const component = new OAuthSelectorComponent(
				"logout",
				providerDataSource(["opencode-go"]),
				providerId => selected.push(providerId),
				() => {},
			);
			await component.ready;
			for (const char of "opencode-go") {
				component.handleInput(char);
			}
			const rendered = component
				.render(80)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(rendered).toContain("OpenCode Go");
		});
	});
});
