import { describe, expect, test } from "bun:test";
import { loadNativeToolSurface } from "../../src/native/tool-pack";

describe("native tool surface", () => {
	test("loads the locked coding tool pack from vendored definitions", async () => {
		const lock = {
			effective_values: [
				{ path: "loop.sequence", value: [{ mode: "coding" }] },
				{
					path: "modes",
					value: [
						{
							name: "coding",
							tools_enabled: [
								"read_file",
								"list_dir",
								"apply_unified_patch",
								"create_file_from_block",
								"run_shell",
								"eval",
								"TodoWrite",
								"mark_task_complete",
							],
						},
					],
				},
			],
		} as const;
		const surface = await loadNativeToolSurface(lock);
		expect(surface.mode).toBe("coding");
		expect(surface.tools.map(tool => tool.name)).toEqual([
			"read_file",
			"list_dir",
			"apply_unified_patch",
			"create_file_from_block",
			"run_shell",
			"eval",
			"TodoWrite",
			"mark_task_complete",
		]);
		expect(surface.byName.get("read_file")?.schema.type).toBe("object");
		expect(surface.byName.get("mark_task_complete")?.schema.required).toEqual(["summary"]);
	});
});
