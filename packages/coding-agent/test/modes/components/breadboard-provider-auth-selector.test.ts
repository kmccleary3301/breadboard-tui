import { beforeAll, describe, expect, it } from "bun:test";
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
});
