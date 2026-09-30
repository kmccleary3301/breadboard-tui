import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { highlightMagicKeywords, setMagicKeywords } from "@oh-my-pi/pi-tui/prompt/magic-keywords";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import {
	MAGIC_KEYWORDS,
	renderOrchestrateNotice,
	renderWorkflowNotice,
} from "@oh-my-pi/pi-coding-agent/modes/magic-keywords";

beforeAll(async () => {
	await initTheme(false, undefined, undefined, undefined, undefined, "truecolor");
	setMagicKeywords(MAGIC_KEYWORDS);
});

afterAll(() => {
	setMagicKeywords([]);
});

describe("magic keyword registry", () => {
	it("keeps ids and words unique so notice types and settings keys cannot collide", () => {
		expect(new Set(MAGIC_KEYWORDS.map(keyword => keyword.id)).size).toBe(MAGIC_KEYWORDS.length);
		expect(new Set(MAGIC_KEYWORDS.map(keyword => keyword.word)).size).toBe(MAGIC_KEYWORDS.length);
	});
});
describe("highlightMagicKeywords", () => {
	it("paints every magic keyword in one prose pass while preserving visible text", () => {
		const input = "first ultrathink then orchestrate the workflowz";
		const decorated = highlightMagicKeywords(input);
		expect(decorated).not.toBe(input);
		expect(decorated).toContain("\x1b[38");
		expect(Bun.stripANSI(decorated)).toBe(input);
		for (const keyword of ["ultrathink", "orchestrate", "workflowz"]) {
			expect(decorated).not.toContain(keyword);
		}
	});

	it("does not paint code spans, fenced blocks, or XML sections", () => {
		const input = "`ultrathink`\n```\norchestrate\n```\n<x>workflowz</x>";
		expect(highlightMagicKeywords(input)).toBe(input);
	});

	it("paints only prose occurrences and restores the supplied foreground", () => {
		const reset = "\x1b[38;2;1;2;3m";
		const decorated = highlightMagicKeywords("`orchestrate` but please orchestrate now", reset);
		expect(decorated).toContain("`orchestrate`");
		expect(Bun.stripANSI(decorated)).toBe("`orchestrate` but please orchestrate now");
		expect(decorated).toContain(reset);
	});

	it("changes gradient bytes as phase advances and wraps phase values", () => {
		const text = "go ultrathink now";
		const frame0 = highlightMagicKeywords(text, undefined, 0);
		const frame1 = highlightMagicKeywords(text, undefined, 0.5);
		expect(Bun.stripANSI(frame0)).toBe(text);
		expect(Bun.stripANSI(frame1)).toBe(text);
		expect(frame0).not.toBe(frame1);
		expect(highlightMagicKeywords(text, undefined, 1)).toBe(frame0);
		expect(highlightMagicKeywords(text, undefined, -0.25)).toBe(highlightMagicKeywords(text, undefined, 0.75));
	});
});

describe("orchestrate notice", () => {
	it("is a self-contained system notice carrying the orchestration contract", () => {
		const notice = renderOrchestrateNotice({
			tools: ["read", "task", "edit", "write", "lsp", "bash", "todo"],
		});
		expect(notice.startsWith("<system-notice>")).toBe(true);
		expect(notice.endsWith("</system-notice>")).toBe(true);
		expect(notice).toContain("orchestrator");
		// The contract must not retain the slash-command input placeholder.
		expect(notice).not.toContain("$@");
	});

	it("omits tool-budget mentions for tools absent from the session", () => {
		const notice = renderOrchestrateNotice({ tools: ["read"] });
		expect(notice).not.toContain("`task` for dispatch");
		expect(notice).not.toContain("`edit`");
		expect(notice).not.toContain("`write`");
		expect(notice).not.toContain("`lsp diagnostics`");
		expect(notice).not.toContain("via `bash`");
		expect(notice).not.toContain("`todo` for tracking");
	});

	it("does not name edit when only write is available", () => {
		const writeOnly = renderOrchestrateNotice({ tools: ["read", "write"] });
		expect(writeOnly).toContain("with `write`");
		expect(writeOnly).not.toContain("`edit`/`write`");
		expect(writeOnly).not.toContain("with `edit`");
	});

	it("does not name write when only edit is available", () => {
		const editOnly = renderOrchestrateNotice({ tools: ["read", "edit"] });
		expect(editOnly).toContain("with `edit`");
		expect(editOnly).not.toContain("`edit`/`write`");
	});
});

describe("workflow notice", () => {
	it("defaults to workpools and hides eval-defined tools when disabled", () => {
		const enabled = renderWorkflowNotice({ taskBatch: true, scoutAvailable: true, evalTools: true });
		const disabled = renderWorkflowNotice({ taskBatch: true, scoutAvailable: true, evalTools: false });
		expect(enabled).toContain("Default to `workpool()`");
		expect(enabled).toContain("`@tool`");
		expect(disabled).toContain("Default to `workpool()`");
		expect(disabled).not.toContain("`@tool`");
		expect(disabled).not.toContain("tools=None");
	});
});
