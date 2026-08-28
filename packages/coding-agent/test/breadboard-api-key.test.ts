import { describe, expect, test } from "bun:test";
import { applyCliApiKeyOverride, BreadboardProductApiKeyError } from "../src/main";

describe("BreadBoard CLI API-key isolation", () => {
	test("rejects --api-key before native AuthStorage can observe it", () => {
		const secretCanary = "sk-product-cli-canary";
		const mutations: unknown[] = [];
		const authStorage = {
			setRuntimeApiKey(provider: string, apiKey: string) {
				mutations.push({ provider, apiKey });
			},
		};

		let observed: BreadboardProductApiKeyError | undefined;
		try {
			applyCliApiKeyOverride(authStorage, {
				apiKey: secretCanary,
				provider: "anthropic",
				breadboardProductModeSelected: true,
			});
		} catch (error) {
			if (error instanceof BreadboardProductApiKeyError) observed = error;
		}

		expect(observed).toBeInstanceOf(BreadboardProductApiKeyError);
		expect(observed?.message).not.toContain(secretCanary);
		expect(mutations).toEqual([]);
	});

	test("retains the native runtime override outside BreadBoard mode", () => {
		const mutations: unknown[] = [];
		const authStorage = {
			setRuntimeApiKey(provider: string, apiKey: string) {
				mutations.push({ provider, apiKey });
			},
		};

		applyCliApiKeyOverride(authStorage, {
			apiKey: "native-key",
			provider: "anthropic",
			breadboardProductModeSelected: false,
		});

		expect(mutations).toEqual([{ provider: "anthropic", apiKey: "native-key" }]);
	});
});
