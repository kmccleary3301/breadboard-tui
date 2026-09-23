import { describe, expect, it } from "bun:test";
import {
	getBreadBoardToolLabel,
	getBreadBoardToolRenderer,
} from "@oh-my-pi/pi-coding-agent/modes/components/breadboard-tool-renderers";
import { toolRenderers } from "@oh-my-pi/pi-tui/tools";

describe("BreadBoard tool renderer aliases", () => {
	it("resolves the effective run_shell id to the existing bash renderer", () => {
		expect(getBreadBoardToolRenderer("run_shell")).toBe(toolRenderers.bash);
		expect(getBreadBoardToolLabel("run_shell")).toBe("Bash");
	});

	it("does not invent a renderer for an unknown effective id", () => {
		expect(getBreadBoardToolRenderer("unknown-tool")).toBeUndefined();
		expect(getBreadBoardToolLabel("unknown-tool")).toBeUndefined();
	});
});
