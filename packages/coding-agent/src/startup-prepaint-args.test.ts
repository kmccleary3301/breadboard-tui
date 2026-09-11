import { describe, expect, test } from "bun:test";
import { parseStartupPrepaintArgs } from "./startup-prepaint-args";

describe("parseStartupPrepaintArgs", () => {
	test("accepts non-submitting model launch forms", () => {
		expect(parseStartupPrepaintArgs([])).toEqual({});
		expect(parseStartupPrepaintArgs(["--no-session", "--model", "mock/reference"])).toEqual({
			modelSelector: "mock/reference",
		});
		expect(parseStartupPrepaintArgs(["--model=mock/reference", "--no-session"])).toEqual({
			modelSelector: "mock/reference",
		});
	});

	test("rejects malformed, duplicate, and work-submitting arguments", () => {
		expect(parseStartupPrepaintArgs(["--model"])).toBeNull();
		expect(parseStartupPrepaintArgs(["--model="])).toBeNull();
		expect(parseStartupPrepaintArgs(["--model", "mock/reference", "--model=mock/other"])).toBeNull();
		expect(parseStartupPrepaintArgs(["fix", "the", "bug"])).toBeNull();
		expect(parseStartupPrepaintArgs(["--resume", "latest"])).toBeNull();
	});
});
