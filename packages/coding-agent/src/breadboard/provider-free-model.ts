import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const PROVIDER_FREE_MODEL_PROVIDERS = new Set(["mock", "cli_mock", "smoke", "replay"]);
const providerFreeModels = new WeakSet<Model>();

export function createBreadboardProviderFreeModel(selector: string): Model | undefined {
	const separator = selector.indexOf("/");
	if (separator <= 0 || separator === selector.length - 1) return undefined;
	const provider = selector.slice(0, separator);
	if (!PROVIDER_FREE_MODEL_PROVIDERS.has(provider)) return undefined;
	const id = selector.slice(separator + 1);
	const model = buildModel({
		id,
		name: selector,
		api: "openai-completions",
		provider,
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 32_768,
	});
	providerFreeModels.add(model);
	return model;
}

export function isBreadboardProviderFreeModel(model: Model): boolean {
	return providerFreeModels.has(model);
}
