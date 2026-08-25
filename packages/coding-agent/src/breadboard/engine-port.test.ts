import { describe, expect, test } from "bun:test";
import {
	buildBreadboardSessionCreatePayload,
	connectCanonicalBreadboardEnginePort,
	filterUncorrelatedCanonicalEvents,
} from "./engine-port";
import type { BreadboardRunConfig } from "./lifecycle/run-config";

const offConfig = {
	mode: "off",
	workspaceId: `workspace:v1:sha256:${"0".repeat(64)}` as BreadboardRunConfig["workspaceId"],
	startupTimeoutMs: 1_000,
	requestTimeoutMs: 1_000,
	sources: {
		mode: "derived-default",
		endpoint: "derived-default",
		auth: "derived-default",
		tls: "derived-default",
		engineArtifact: "derived-default",
		workspaceId: "derived-default",
		startupTimeoutMs: "derived-default",
		requestTimeoutMs: "derived-default",
		ownerExitPolicy: "derived-default",
		sessionConfigPath: "derived-default",
	},
	configDigest: `sha256:${"0".repeat(64)}` as BreadboardRunConfig["configDigest"],
} satisfies BreadboardRunConfig;

const unavailableLocalConfig = {
	...offConfig,
	mode: "local-owned",
	endpoint: "http://127.0.0.1:41739",
	ownerExitPolicy: "attached",
} satisfies BreadboardRunConfig;

describe("connectCanonicalBreadboardEnginePort", () => {
	test("connects through the lifecycle supervisor and reports non-ready ownership results", async () => {
		const failures: string[] = [];
		const connection = await connectCanonicalBreadboardEnginePort(offConfig, {
			onLateSessionCloseError: () => {},
			onLifecycleFailure: failure => failures.push(failure.state.name),
		});

		expect(connection.kind).toBe("failure");
		if (connection.kind === "failure") expect(connection.result.kind).toBe("off");
		expect(failures).toEqual([]);
	});

	test("returns synchronous startup failures without invoking the late-failure callback", async () => {
		const failures: string[] = [];
		const connection = await connectCanonicalBreadboardEnginePort(unavailableLocalConfig, {
			onLateSessionCloseError: () => {},
			onLifecycleFailure: failure => failures.push(failure.state.name),
		});

		expect(connection.kind).toBe("failure");
		if (connection.kind === "failure") expect(connection.result.kind).toBe("failure");
		expect(failures).toEqual([]);
	});
});

describe("filterUncorrelatedCanonicalEvents", () => {
	test("retains canonical correlation even when the legacy numeric turn is null", async () => {
		const envelope = (sequence: number, type: string, correlation: boolean, payload: object = {}): string =>
			[
				`id: ${sequence}`,
				`data: ${JSON.stringify({
					stable_cursor: true,
					id: `event-${sequence}`,
					seq: sequence,
					session_id: "session-1",
					input_id: correlation ? "input-1" : null,
					turn_id: correlation ? "turn-1" : null,
					turn: null,
					timestamp_ms: sequence,
					type,
					payload,
				})}`,
				"",
				"",
			].join("\n");
		const response = new Response(
			[
				`data: ${JSON.stringify({ stable_cursor: false, type: "stream.open", payload: {} })}\n\n`,
				envelope(3, "ctree_node", true),
				envelope(4, "user_message", true),
				envelope(5, "ctree_node", false),
				envelope(6, "warning", false),
				envelope(7, "assistant_message", true, { text: "done\n\n>>>>>> END RESPONSE" }),
				envelope(8, "completion", true, { summary: { completed: true } }),
				envelope(9, "run_finished", true, { completed: true }),
				envelope(10, "turn_completed", true),
			].join(""),
			{ headers: { "content-type": "text/event-stream" } },
		);

		const filtered = await filterUncorrelatedCanonicalEvents(response).text();

		expect(filtered).toContain('"seq":3');
		expect(filtered).toContain('"seq":4');
		expect(filtered).toContain('"seq":5');
		expect(filtered).not.toContain('"seq":6');
		expect(filtered).toContain('"seq":7');
		expect(filtered).toContain('"type":"assistant.message.end"');
		expect(filtered).toContain('"text":"done"');
		expect(filtered).not.toContain(">>>>>> END RESPONSE");
		expect(filtered).toContain('"seq":8');
		expect(filtered).toContain('"type":"completion"');
		expect(filtered).toContain('"seq":9');
		expect(filtered).toContain('"type":"run_finished"');
		expect(filtered).toContain('"seq":10');
		expect(filtered).toContain('"type":"turn_completed"');
	});
});

describe("taskless session create adapter", () => {
	test("omits config_path from the JSON payload for the bundled default", () => {
		const payload = buildBreadboardSessionCreatePayload({ workspace: "/canonical/project" });
		expect(JSON.stringify(payload)).toBe('{"task":"","workspace":"/canonical/project"}');
		expect("config_path" in JSON.parse(JSON.stringify(payload))).toBe(false);
	});

	test("retains an explicit config path byte-for-byte", () => {
		const configPath = "/profiles/daily_driver.v1.yaml";
		const payload = buildBreadboardSessionCreatePayload({ workspace: "/canonical/project", configPath });
		expect(JSON.parse(JSON.stringify(payload))).toEqual({
			config_path: configPath,
			task: "",
			workspace: "/canonical/project",
		});
	});

	test("preserves every canonical create option through the legacy payload boundary", () => {
		expect(
			buildBreadboardSessionCreatePayload({
				configPath: "/profiles/custom.yaml",
				task: "ship it",
				overrides: { "providers.default_model": "mock/reference" },
				metadata: { source: "tui" },
				workspace: "/canonical/project",
				maxSteps: 7,
				permissionMode: "prompt",
				stream: false,
			}),
		).toEqual({
			config_path: "/profiles/custom.yaml",
			task: "ship it",
			overrides: { "providers.default_model": "mock/reference" },
			metadata: { source: "tui" },
			workspace: "/canonical/project",
			max_steps: 7,
			permission_mode: "prompt",
			stream: false,
		});
	});

	test("rejects an empty explicit config path instead of treating it as the bundled default", () => {
		expect(() => buildBreadboardSessionCreatePayload({ configPath: "", workspace: "/canonical/project" })).toThrow(
			"empty config path",
		);
	});
});
