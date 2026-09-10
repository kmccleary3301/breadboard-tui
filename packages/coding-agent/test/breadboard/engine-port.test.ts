import { describe, expect, test } from "bun:test";
import {
	buildBreadboardSessionControlRequest,
	buildBreadboardSessionCreatePayload,
} from "../../src/breadboard/engine-port";

describe("BreadBoard engine session controls", () => {
	test("builds mode, role, and skills command payloads", () => {
		expect(buildBreadboardSessionControlRequest({ command: "set_mode", mode: "plan" })).toEqual({
			command: "set_mode",
			payload: { mode: "plan" },
		});
		expect(
			buildBreadboardSessionControlRequest({ command: "set_role", role: "reviewer", model: "mock/reference" }),
		).toEqual({
			command: "set_role",
			payload: { role: "reviewer", model: "mock/reference" },
		});
		expect(buildBreadboardSessionControlRequest({ command: "set_skills", selected: ["search", "patch"] })).toEqual({
			command: "set_skills",
			payload: { selected: ["search", "patch"] },
		});
	});
});

describe("BreadBoard engine session creation payload", () => {
	test("keeps the YAML config path separate from the effective lock reference", () => {
		expect(
			buildBreadboardSessionCreatePayload({
				workspace: "/canonical/project",
				configPath: "agent_configs/daily_driver.v1.yaml",
				lockId: "agent_configs/daily_driver.v1.lock.json",
			}),
		).toEqual({
			config_path: "agent_configs/daily_driver.v1.yaml",
			lock_id: "agent_configs/daily_driver.v1.lock.json",
			task: "",
			workspace: "/canonical/project",
		});
	});

	test("omits lock_id when the session target has no lock", () => {
		const payload = buildBreadboardSessionCreatePayload({
			workspace: "/canonical/project",
			configPath: "agent_configs/daily_driver.v1.yaml",
		});
		expect(payload).toEqual({
			config_path: "agent_configs/daily_driver.v1.yaml",
			task: "",
			workspace: "/canonical/project",
		});
		expect("lock_id" in payload).toBe(false);
	});
});
