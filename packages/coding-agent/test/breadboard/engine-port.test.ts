import { describe, expect, test } from "bun:test";
import { buildBreadboardSessionControlRequest } from "../../src/breadboard/engine-port";

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
