import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { todoCompletionGuardReason, TodoWriteState } from "../../src/native/todo-write";
import type { JsonRecord } from "../../src/canonical-json";

type TodoCase = {
	readonly input: JsonRecord;
	readonly native: { readonly apply: JsonRecord; readonly openItems: string[] };
};
type TodoBundle = { readonly cases: Record<string, TodoCase> };
type GuardCase = { readonly open_titles: string[]; readonly reason: string | null };
type GuardBundle = { readonly cases: Record<string, GuardCase> };

const FIXTURES = new URL("./fixtures/todo-write/", import.meta.url);
const manager = JSON.parse(await readFile(new URL("manager.json", FIXTURES), "utf8")) as TodoBundle;
const guard = JSON.parse(await readFile(new URL("guard.json", FIXTURES), "utf8")) as GuardBundle;

// Todo board fixtures come from TodoManager.handle_write_board (todo/manager.py:132-177)
// and the Claude-facing result from agent_llm_openai.py:5618-5636.
describe("TodoWriteState fixtures", () => {
	for (const [name, fixture] of Object.entries(manager.cases)) {
		test(name, () => {
			const state = new TodoWriteState();
			expect(state.apply(fixture.input)).toEqual(fixture.native.apply);
			expect(state.openItems).toEqual(fixture.native.openItems);
		});
	}
});
// Guard text is captured from guardrails/orchestrator.py:495-508.
describe("TodoWrite completion guard fixtures", () => {
	for (const [count, fixture] of Object.entries(guard.cases)) {
		test(`${count} open items`, () => {
			const state = new TodoWriteState();
			state.apply({ todos: fixture.open_titles.map(content => ({ content, status: "todo" })) });
			expect(state.openItems).toEqual(fixture.open_titles);
			expect(todoCompletionGuardReason(state) ?? null).toBe(fixture.reason);
		});
	}
});
