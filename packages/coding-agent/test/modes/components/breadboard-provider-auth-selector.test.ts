import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import {
	BreadboardProviderAuthSelectorComponent,
	type AuthCredentialView,
	type AuthProviderView,
	type ProviderAuthReadPort,
} from "@oh-my-pi/pi-tui/overlays/breadboard-provider-auth-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme();
});

function providerDataSource(storedProviders: readonly string[] = []): ProviderAuthReadPort {
	return {
		async listProviders() {
			return getOAuthProviders().map(provider => ({
				providerId: provider.id,
				displayName: provider.name,
				storeCredentialsAs: provider.storeCredentialsAs,
				supportTier: "core",
				authOwner: "provider",
				available: provider.available,
				authSchemes: ["oauth2"],
				loginAvailable: provider.available,
			}));
		},
		async listCredentials() {
			return storedProviders.map(
				providerId =>
					({
						providerId,
						status: "active",
						source: "oauth",
					}) satisfies AuthCredentialView,
			);
		},
	};
}

describe("BreadboardProviderAuthSelectorComponent", () => {
	it("distinguishes pending provider discovery from an empty catalog", async () => {
		const pending = Promise.withResolvers<readonly AuthProviderView[]>();
		const source = providerDataSource();
		const component = new BreadboardProviderAuthSelectorComponent(
			"login",
			{ ...source, listProviders: () => pending.promise },
			() => {},
			() => {},
		);
		const loading = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(loading).toMatch(/loading/i);
		expect(loading).not.toMatch(/no .*providers/i);
		pending.resolve(await source.listProviders());
		await component.ready;
		expect(
			component
				.render(80)
				.map(line => Bun.stripANSI(line))
				.join("\n"),
		).not.toMatch(/loading/i);
	});

	it("does not restart credential validation after closing during discovery", async () => {
		const pending = Promise.withResolvers<readonly AuthProviderView[]>();
		const source = providerDataSource(["opencode-go"]);
		const validated: string[] = [];
		const component = new BreadboardProviderAuthSelectorComponent(
			"login",
			{ ...source, listProviders: () => pending.promise },
			() => {},
			() => {},
			{
				validateAuth: async provider => {
					validated.push(provider);
					return true;
				},
			},
		);
		component.handleInput("\x1b");
		pending.resolve(await source.listProviders());
		await component.ready;
		expect(validated).toEqual([]);
	});

	it("allows revoking stored credentials when a provider cannot accept new logins", async () => {
		const source = providerDataSource(["opencode-go"]);
		const providers = (await source.listProviders())
			.filter(provider => provider.providerId === "opencode-go")
			.map(provider => ({
				...provider,
				available: false,
				loginAvailable: false,
				availabilityReason: "provider_managed" as const,
			}));
		const selected: string[] = [];
		const component = new BreadboardProviderAuthSelectorComponent(
			"revoke",
			{ ...source, listProviders: async () => providers },
			provider => selected.push(provider),
			() => {},
		);
		await component.ready;
		component.handleInput("\n");
		expect(selected).toEqual(["opencode-go"]);
	});
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
		const component = new BreadboardProviderAuthSelectorComponent(
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
		const component = new BreadboardProviderAuthSelectorComponent(
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
		const component = new BreadboardProviderAuthSelectorComponent(
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

			const component = new BreadboardProviderAuthSelectorComponent(
				"login",
				providerDataSource(),
				() => {},
				() => {},
				{ disabledProviders: settings.get("disabledProviders") },
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

			const component = new BreadboardProviderAuthSelectorComponent(
				"login",
				providerDataSource(),
				() => {},
				() => {},
				{ disabledProviders: settings.get("disabledProviders") },
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
			const component = new BreadboardProviderAuthSelectorComponent(
				"logout",
				providerDataSource(["opencode-go"]),
				providerId => selected.push(providerId),
				() => {},
				{ disabledProviders: settings.get("disabledProviders") },
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
