import { describe, expect, test } from "bun:test";
import { RESEARCH_NATIVE_BINDINGS } from "../../src/native/research-bindings";

type JsonObject = Record<string, unknown>;

async function delegatedInput(name: string, input: JsonObject): Promise<JsonObject> {
	let received: JsonObject | undefined;
	const binding = RESEARCH_NATIVE_BINDINGS[name];
	if (binding === undefined) throw new Error(`missing binding ${name}`);
	await binding.run({
		input,
		harness: {} as never,
		context: {
			invokeTool: async (params: JsonObject) => {
				received = params;
				return { content: [{ type: "text", text: "ok" }] };
			},
		} as never,
		signal: undefined,
		onUpdate: undefined,
		todos: {} as never,
		guard: {} as never,
	});
	if (received === undefined) throw new Error(`${name} did not invoke a builtin`);
	return received;
}

describe("research native builtin argument mappings", () => {
	test("preserves the path fields used by the Pi and OMO-Pi read/write/edit schemas", async () => {
		expect(await delegatedInput("read", { path: "fixture.txt", offset: 1, limit: 20 })).toEqual({
			path: "fixture.txt",
			offset: 1,
			limit: 20,
		});
		expect(await delegatedInput("write", { path: "out.txt", content: "x" })).toEqual({
			filePath: "out.txt",
			content: "x",
		});
		expect(await delegatedInput("edit", { path: "fixture.txt", oldText: "a", newText: "b" })).toEqual({
			filePath: "fixture.txt",
			oldString: "a",
			newString: "b",
		});
		expect(await delegatedInput("edit", { file_name: "fixture.txt", search: "a", replace: "b" })).toEqual({
			filePath: "fixture.txt",
			oldString: "a",
			newString: "b",
		});
	});

	test("maps search, listing, glob, find, and shell schema variants", async () => {
		expect(await delegatedInput("grep", { pattern: "fixture", path: ".", glob: "*.txt" })).toEqual({
			pattern: "fixture",
			path: ".",
			include: "*.txt",
		});
		expect(await delegatedInput("grep", { path: "fixture.txt", offset: 1, limit: 20 })).toEqual({
			path: "fixture.txt",
			offset: 1,
			limit: 20,
		});
		expect(await delegatedInput("glob", { path: ".", depth: 2 })).toEqual({ path: ".", pattern: "**/*" });
		expect(await delegatedInput("list", { path: "." })).toEqual({ path: ".", pattern: "*" });
		expect(await delegatedInput("find", { pattern: "*.ts", path: "src" })).toEqual({
			pattern: "*.ts",
			path: "src",
		});
		expect(await delegatedInput("bash", { command: "printf ok", timeout: 5 })).toEqual({
			command: "printf ok",
			timeout: 5,
		});
	});
});
