import type { PublicResult } from "@breadboard/sdk";
import type { BreadboardClient, SessionSummary } from "@breadboard/sdk/engine";
import { describe, expect, test } from "bun:test";
import { createHarnessPort, listHarnessChoices } from "../../src/breadboard/harness-port-client";

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
		listHarness: async () => envelope({ harnesses: ["daily_driver.v1.yaml", "codex.yaml"], count: 2 }),
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
