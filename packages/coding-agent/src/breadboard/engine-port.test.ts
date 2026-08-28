import { describe, expect, test } from "bun:test";
import { decodeLoggedSessionEvent } from "@breadboard/sdk/internal";
import {
	buildBreadboardSessionCreatePayload,
	connectCanonicalBreadboardEnginePort,
	createCanonicalEventFetch,
	createLifecycleMonitor,
} from "./engine-port";
import { lifecycleFailure, lifecycleState } from "./lifecycle/lifecycle-state";
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

describe("createLifecycleMonitor", () => {
	const authority = {
		mode: "local-owned",
		engineInstanceId: "engine-instance-1",
		engineBootId: "engine-boot-1",
		registrationId: "registration-1",
		registrationGeneration: 3,
		ownerGeneration: 7,
	} as const;

	test("latches confirmed post-ready replacement as an authority discontinuity", () => {
		const presented: string[] = [];
		const monitor = createLifecycleMonitor(result => presented.push(result.state.name));
		monitor.stateChanged(lifecycleState("local-owned", "ready"));
		monitor.activateAuthority(authority);
		monitor.stateChanged(lifecycleState("local-owned", "reconnecting", 1));
		expect(monitor.signal.failure()).toBeUndefined();

		const replacement = lifecycleState("local-owned", "backing-off", 1);
		monitor.stateChanged(replacement);
		expect(monitor.signal.failure()).toMatchObject({
			kind: "failure",
			state: { name: "identity-changed", reason: "identity_changed", attempt: 1 },
		});
		expect(monitor.signal.authorityDiscontinuity()).toEqual({
			previous: authority,
			trigger: replacement,
		});
		monitor.stateChanged(lifecycleFailure("local-owned", "failed", "restart_budget_exhausted", 2).state);
		expect(presented).toEqual(["identity-changed"]);
	});

	test("treats a second ready generation as replacement but rejects authority rebinding", () => {
		const monitor = createLifecycleMonitor();
		monitor.activateAuthority(authority);
		expect(() => monitor.activateAuthority({ ...authority, engineBootId: "engine-boot-2" })).toThrow(
			"authority is already active",
		);
		monitor.stateChanged(lifecycleState("local-owned", "ready"));
		expect(monitor.signal.authorityDiscontinuity()?.previous).toEqual(authority);
		expect(monitor.signal.failure()?.state.name).toBe("identity-changed");
	});
});

describe("createCanonicalEventFetch", () => {
	test("adds the strict event query without mutating the canonical response", async () => {
		const response = new Response("canonical stream", { headers: { "content-type": "text/event-stream" } });
		let requestedUrl: URL | undefined;
		const requestFetch = Object.assign(
			async (input: Parameters<typeof fetch>[0]) => {
				requestedUrl = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
				return response;
			},
			{ preconnect() {} },
		) satisfies typeof fetch;
		const canonicalFetch = createCanonicalEventFetch(requestFetch);

		const received = await canonicalFetch("http://127.0.0.1:41739/v1/sessions/session-1/events?after=event-1");

		expect(received).toBe(response);
		expect(requestedUrl?.pathname).toBe("/v1/sessions/session-1/events");
		expect(requestedUrl?.searchParams.get("after")).toBe("event-1");
		expect(requestedUrl?.searchParams.get("schema")).toBe("2");
		expect(requestedUrl?.searchParams.get("include_legacy")).toBe("false");
	});

	test("does not add event parameters to another canonical route", async () => {
		const response = new Response("{}");
		let requestedUrl: URL | undefined;
		const requestFetch = Object.assign(
			async (input: Parameters<typeof fetch>[0]) => {
				requestedUrl = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
				return response;
			},
			{ preconnect() {} },
		) satisfies typeof fetch;

		expect(await createCanonicalEventFetch(requestFetch)("http://127.0.0.1:41739/v1/sessions/session-1")).toBe(
			response,
		);
		expect(requestedUrl?.searchParams.has("schema")).toBe(false);
		expect(requestedUrl?.searchParams.has("include_legacy")).toBe(false);
	});

	test("leaves canonical scope and family validation to the pinned SDK decoder", () => {
		const envelope = (type: string, correlated: boolean) => ({
			stable_cursor: true,
			id: "event-1",
			seq: 1,
			session_id: "session-1",
			input_id: correlated ? "input-1" : null,
			turn_id: correlated ? "turn-1" : null,
			timestamp_ms: 1,
			type,
			payload: type === "error" ? { code: "worker_crash", message: "must-not-render" } : {},
		});

		expect(decodeLoggedSessionEvent(envelope("error", false))).toMatchObject({
			kind: "runtime_error_observed",
			scope: "session",
			inputId: null,
			turnId: null,
			payload: { error: { code: "worker_crash", message: "[redacted]" } },
		});
		expect(() => decodeLoggedSessionEvent(envelope("warning", false))).toThrow(
			"Session protocol error (missing_turn_correlation)",
		);
		expect(() => decodeLoggedSessionEvent(envelope("future_runtime_family", true))).toThrow(
			"Session protocol error (unsupported_event_family)",
		);
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
