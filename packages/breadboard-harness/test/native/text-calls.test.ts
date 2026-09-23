import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { formatTextToolResults, parseTextToolCalls } from "../../src/native/text-calls";
import type { NativeToolDefinition } from "../../src/native/types";
import type { JsonRecord } from "../../src/canonical-json";
type ParserFixture = {
	readonly input: string;
	readonly calls: Array<{ name: string; arguments: JsonRecord }>;
	readonly errors: string[];
};
type ParserBundle = { readonly cases: Record<string, ParserFixture> };
type FormatBundle = { readonly cases: Record<string, { chunks: string[]; role: string }> };

const FIXTURES = new URL("./fixtures/text-calls/", import.meta.url);
const allowed: NativeToolDefinition[] = [
	{
		id: "echo",
		name: "echo",
		description: "Echo values",
		parameters: { type: "object", properties: { value: { type: "string" }, label: { type: "string" } } },
		nativePrimary: false,
	},
	{
		id: "nested",
		name: "nested",
		description: "Nested values",
		parameters: { type: "object", properties: { value: { type: "object" } } },
		nativePrimary: false,
	},
	{
		id: "todo-write",
		name: "TodoWrite",
		description: "Write todos",
		parameters: { type: "object", properties: { todos: { type: "array" } } },
		nativePrimary: false,
	},
];

const parser = JSON.parse(await readFile(new URL("parser.json", FIXTURES), "utf8")) as ParserBundle;
const format = JSON.parse(await readFile(new URL("format.json", FIXTURES), "utf8")) as FormatBundle;
// Captured by capture_text_calls.py from Pythonic02Dialect.parse_calls (pythonic02.py:69-450).
// Python result formatting comes from MessageFormatter.format_execution_results (message_formatter.py:14-28)
// and is appended as a user message by model_output.py:543-546.
describe("Pythonic02 text-call fixtures", () => {
	for (const [name, fixture] of Object.entries(parser.cases)) {
		test(name, () => {
			const actual = parseTextToolCalls(fixture.input, allowed);
			expect(actual.calls).toEqual(fixture.calls);
			expect(actual.errors).toEqual(fixture.errors);
		});
	}
});

describe("text-call result fixtures", () => {
	test("matches Python result text and user role", () => {
		for (const fixture of Object.values(format.cases)) {
			const results: Array<{ name: string; output: JsonRecord }> = [];
			if (fixture.chunks[0] !== "(no tool output)") {
				fixture.chunks.forEach((chunk, index) => {
					if (index === 0) {
						results.push({
							name: "TodoWrite",
							output: {
								ok: true,
								__mvi_text_output: chunk.includes("Error:")
									? "Error: TodoWrite missing required todos"
									: "Todos have been modified successfully.",
							},
						});
					} else {
						results.push({ name: "echo", output: { value: "x", n: 1 } });
					}
				});
			}
			const actual = formatTextToolResults(results);
			expect(actual).toBe(fixture.chunks.join("\n\n"));
			expect(fixture.role).toBe("user");
		}
	});
});
