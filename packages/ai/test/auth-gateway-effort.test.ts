import { join } from "node:path";
import { afterEach, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { readObservedGatewayEffort, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

afterEach(() => clearCustomApis());

it("isolates request effort by session and clears it when a later request omits effort", async () => {
	registerMockApi();
	const directory = TempDir.createSync("gateway-effort-");
	const storage = await AuthStorage.create(join(directory.path(), "auth.db"));
	storage.setRuntimeApiKey("mock", "test-key");
	const model = createMockModel({ provider: "mock", id: "effort-model", handler: () => ({ content: ["OK"] }) });
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["test-token"],
		storage,
		resolveModel: () => model.model,
		version: "test",
	});
	const first = `bb:${crypto.randomUUID()}`;
	const second = `bb:${crypto.randomUUID()}`;
	async function request(key: string, effort?: Effort) {
		const response = await fetch(`${gateway.url}/v1/responses`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
			body: JSON.stringify({
				model: "effort-model",
				input: "Reply OK",
				prompt_cache_key: key,
				stream: false,
				...(effort === undefined ? {} : { reasoning: { effort } }),
			}),
		});
		await response.text();
		expect(response.status).toBe(200);
	}
	try {
		expect(readObservedGatewayEffort(first)).toBeUndefined();
		await request(first, Effort.High);
		await request(second, Effort.Low);
		expect(readObservedGatewayEffort(first)).toBe(Effort.High);
		expect(readObservedGatewayEffort(second)).toBe(Effort.Low);
		await request(first);
		expect(readObservedGatewayEffort(first)).toBeNull();
		expect(readObservedGatewayEffort(second)).toBe(Effort.Low);
	} finally {
		await gateway.close();
		storage.close();
		directory.removeSync();
	}
});
