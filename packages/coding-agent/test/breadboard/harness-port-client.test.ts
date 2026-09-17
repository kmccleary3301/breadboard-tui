import type { PublicResult } from "@breadboard/sdk";
import { ApiError, type BreadboardClient, type SessionSummary } from "@breadboard/sdk/engine";
import { describe, expect, test } from "bun:test";
import { createHarnessPort, listHarnessChoices, resolveHarnessId } from "../../src/breadboard/harness-port-client";

const envelope = (data: Readonly<Record<string, unknown>>): PublicResult => ({
	schema_version: "bb.cli.result.v1",
	ok: true,
	status: "ok",
	command: [],
	record_refs: [],
	hashes: {},
	stage_outcomes: [],
	warnings: [],
	next_actions: [],
	error: null,
	exit_code: 0,
	data,
});

const definition = {
	schema_version: "bb.harness_definition.v1",
	profile: { name: "Daily Driver" },
	providers: { default_model: "mock/reference" },
	modes: [{ name: "coding" }],
} as const;

const lock = {
	schema_version: "bb.effective_config_graph.v1",
	graph_hash: "sha256:lock",
	source_layers: [{ layer_id: "harness-source:0000", source_ref: "daily_driver.v1.yaml" }],
	effective_values: [
		{
			path: "providers.default_model",
			value: "mock/reference",
			source_layer_id: "harness-source:0000",
			visibility: "model-visible",
		},
	],
} as const;

const session: SessionSummary = {
	session_id: "session-1",
	status: "running",
	generation_id: "generation-2",
	trajectory_segment_id: "segment-1",
	lineage: null,
	effective_lock_hash: "sha256:lock",
	mode: "coding",
};

function clientFor(calls: string[], nextSession: SessionSummary = session): BreadboardClient {
	return {
		getHarness: async id => {
			calls.push(`get:${id}`);
			return envelope({ path: "daily_driver.v1.yaml", definition });
		},
		explainHarness: async id => {
			calls.push(`explain:${id}`);
			return envelope({
				schema_version: "bb.config_explanation.v1",
				fields: [{ path: "providers.default_model", source_layer: "harness-source:0000" }],
			});
		},
		getHarnessLock: async id => {
			calls.push(`lock:${id}`);
			return envelope({ path: id, lock });
		},
		getSession: async id => {
			calls.push(`session:${id}`);
			return nextSession;
		},
		listHarness: async directory => {
			calls.push(`list:${directory ?? "."}`);
			return envelope({ harnesses: ["daily_driver.v1.yaml", "codex.yaml"], count: 2 });
		},
	} as BreadboardClient;
}

describe("createHarnessPort", () => {
	test("maps recorded harness, explain, lock, and session payloads", async () => {
		const calls: string[] = [];
		const port = createHarnessPort({
			client: clientFor(calls),
			sessionId: "session-1",
			harnessId: "daily_driver.v1.yaml",
			now: () => 42,
		});
		const seen: string[] = [];
		port.subscribe(snapshot => seen.push(`${snapshot?.name}:${snapshot?.generation}`));

		const snapshot = await port.refresh("session-open");

		expect(snapshot).toMatchObject({
			harnessId: "daily_driver.v1.yaml",
			name: "Daily Driver",
			lockHash: "sha256:lock",
			verifiedIdentity: { harnessId: "daily_driver.v1.yaml", lockHash: "sha256:lock" },
			generation: "generation-2",
			mode: "coding",
			loadedAt: 42,
		});
		expect(snapshot?.provenance["providers.default_model"]).toEqual({ source: "daily_driver.v1.yaml", line: null });
		expect(calls.sort()).toEqual([
			"explain:daily_driver.v1.yaml",
			"get:daily_driver.v1.yaml",
			"lock:daily_driver.v1.lock.json",
			"session:session-1",
		]);
		expect(seen).toEqual(["Daily Driver:generation-2"]);
	});
	test("refreshes the session with the current engine session id", async () => {
		const calls: string[] = [];
		const engineSessionId = "engine-session-1";
		const port = createHarnessPort({
			client: clientFor(calls),
			sessionId: () => engineSessionId,
			harnessId: "daily_driver.v1.yaml",
		});

		await port.refresh("session-open");

		expect(calls).toContain(`session:${engineSessionId}`);
		expect(calls).not.toContain(`session:${session.session_id}`);
	});
	test("attributes refresh failures to the engine operation", async () => {
		for (const operation of ["harness.explain", "harness_lock.get", "session.get"] as const) {
			const client = clientFor([]);
			if (operation === "harness.explain") {
				client.explainHarness = async () => {
					throw new Error("boom");
				};
			} else if (operation === "harness_lock.get") {
				client.getHarnessLock = async () => {
					throw new Error("boom");
				};
			} else {
				client.getSession = async () => {
					throw new Error("boom");
				};
			}
			const port = createHarnessPort({
				client,
				sessionId: "engine-session-1",
				harnessId: "daily_driver.v1.yaml",
			});

			await expect(port.refresh("session-open")).rejects.toThrow(`BreadBoard ${operation} failed: boom`);
		}
	});
	test("hides lock and provenance when the session lock hash does not match", async () => {
		const port = createHarnessPort({
			client: clientFor([], { ...session, effective_lock_hash: "sha256:other" }),
			sessionId: "session-1",
			harnessId: "daily_driver.v1.yaml",
		});

		const snapshot = await port.refresh("session-open");

		expect(snapshot?.verifiedIdentity).toBeNull();
		expect(snapshot?.lock).toBeNull();
		expect(snapshot?.provenance).toEqual({});
	});

	test("keeps configuration identity visible when the optional source lock file is absent", async () => {
		const client = clientFor([]);
		client.getHarnessLock = async () => {
			throw new ApiError("path_unavailable: path is unavailable", 404, {
				error: { error_code: "path_unavailable", message: "path is unavailable" },
			});
		};
		const port = createHarnessPort({ client, sessionId: "session-1", harnessId: "daily_driver.v1.yaml" });

		const snapshot = await port.refresh("session-open");

		expect(snapshot?.harnessId).toBe("daily_driver.v1.yaml");
		expect(snapshot?.name).toBe("Daily Driver");
		expect(snapshot?.lockHash).toBe(session.effective_lock_hash);
		expect(snapshot?.verifiedIdentity).toBeNull();
		expect(snapshot?.lock).toBeNull();
		expect(snapshot?.provenance).toEqual({});
	});

	test("does not notify when a refresh returns the same effective snapshot", async () => {
		let notifications = 0;
		const port = createHarnessPort({
			client: clientFor([]),
			sessionId: "session-1",
			harnessId: "daily_driver.v1.yaml",
			now: () => 100,
		});
		port.subscribe(() => notifications++);
		await port.refresh("session-open");
		await port.refresh("manual");
		expect(notifications).toBe(1);
	});

	test("notifies on a changed generation", async () => {
		const calls: string[] = [];
		let currentSession = session;
		const client = clientFor(calls, currentSession);
		client.getSession = async () => currentSession;
		const port = createHarnessPort({ client, sessionId: "session-1", harnessId: "daily_driver.v1.yaml" });
		const generations: Array<string | null> = [];
		port.subscribe(snapshot => generations.push(snapshot?.generation ?? null));
		await port.refresh("session-open");
		currentSession = { ...session, generation_id: "generation-3", mode: "review" };
		await port.refresh("generation-change");
		expect(generations).toEqual(["generation-2", "generation-3"]);
	});
});

test("listHarnessChoices parses public harness references", async () => {
	const choices = await listHarnessChoices(clientFor([]));
	expect(choices).toEqual([
		{ id: "daily_driver.v1.yaml", name: "daily_driver.v1", path: "daily_driver.v1.yaml" },
		{ id: "codex.yaml", name: "codex", path: "codex.yaml" },
	]);
});

test("listHarnessChoices forwards an explicit directory", async () => {
	const calls: string[] = [];
	await listHarnessChoices(clientFor(calls), "agent_configs");
	expect(calls).toContain("list:agent_configs");
});

test("resolves bare harness names through the engine-resolvable v2 path", async () => {
	const calls: string[] = [];
	const client = {
		getHarness: async (id: string) => {
			calls.push(id);
			if (id !== "agent_configs/v2/codex.yaml") throw new ApiError("path_unavailable: path is unavailable", 404, {});
			return envelope({ path: id, definition });
		},
	} as BreadboardClient;

	await expect(resolveHarnessId(client, "codex")).resolves.toBe("agent_configs/v2/codex.yaml");
	expect(calls).toEqual(["agent_configs/v2/codex.yaml"]);
});

test("surfaces a named harness error with the SDK error code", async () => {
	const client = {
		getHarness: async () => {
			throw new ApiError("path_unavailable: path is unavailable", 404, {
				error: { error_code: "path_unavailable", message: "path is unavailable" },
			});
		},
	} as unknown as BreadboardClient;

	await expect(resolveHarnessId(client, "missing")).rejects.toMatchObject({
		name: "HarnessResolutionError",
		code: "harness_unavailable",
		sdkCode: "path_unavailable",
		status: 404,
	});
	await expect(resolveHarnessId(client, "missing")).rejects.toThrow("BreadBoard harness unavailable");
});
