import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	evalOutcomeFromOmp,
	formatEvalResult,
	formatRunShellResult,
	runShellOutcomeFromBash,
} from "../../src/native/shell-eval-results";
import type { NativeToolResult } from "../../src/native/types";

const FIXTURES = join(import.meta.dir, "fixtures", "shell-eval");

type Fixture = {
	operation: "run_shell" | "eval";
	case: string;
	input: Record<string, string | number | boolean>;
	python: {
		text: string;
		details: Record<string, string | number | boolean | null>;
		isError?: boolean;
	};
};

function expectedResult(fixture: Fixture): NativeToolResult {
	return {
		text: fixture.python.text,
		details: fixture.python.details,
		...(fixture.python.isError ? { isError: true } : {}),
	};
}

function formatFixture(fixture: Fixture): NativeToolResult {
	if (fixture.operation === "run_shell") {
		return formatRunShellResult({
			output: String(fixture.input.output),
			exitCode: typeof fixture.input.exitCode === "number" ? fixture.input.exitCode : undefined,
			timedOut: fixture.input.timedOut === true,
			cancelled: fixture.input.cancelled === true,
		});
	}
	return formatEvalResult({
		output: String(fixture.input.output),
		isError: fixture.input.isError === true,
		language: fixture.input.language === "js" ? "js" : "py",
	});
}

describe("native shell/eval result formatting", () => {
	test("replays every oracle and captured fixture byte-exactly", async () => {
		const paths = (await readdir(FIXTURES)).filter(path => path.endsWith(".json")).sort();
		for (const path of paths) {
			const fixture = JSON.parse(await readFile(join(FIXTURES, path), "utf8")) as Fixture;
			expect(formatFixture(fixture), path).toEqual(expectedResult(fixture));
		}
	});

	test("maps bash output and strips OMP's wall-time and timeout notices", () => {
		const leading = runShellOutcomeFromBash({
			content: [{ type: "text", text: "[Command timed out after 30 seconds]\npartial\n\nWall time: 1.25 seconds" }],
			details: { timedOut: true, wallTimeMs: 1_250 },
			isError: true,
		});
		const trailing = runShellOutcomeFromBash({
			content: [
				{ type: "text", text: "partial\n\n[Command timed out after 30 seconds]\n\nWall time: 1.25 seconds" },
			],
			details: { timedOut: true, wallTimeMs: 1_250 },
			isError: true,
		});
		expect(leading).toEqual({ output: "partial", exitCode: 124, timedOut: true, cancelled: false });
		expect(trailing).toEqual(leading);
		expect(formatRunShellResult(leading)).toEqual({
			text: '{"stdout": "partial", "exit": 124, "__mvi_text_output": "partial\\nCommand timed out", "stderr": "Command timed out"}',
			details: {
				stdout: "partial",
				exit: 124,
				__mvi_text_output: "partial\nCommand timed out",
				stderr: "Command timed out",
			},
			isError: true,
		});
	});

	test("maps a failed bash result without inventing stderr", () => {
		const outcome = runShellOutcomeFromBash({
			content: [{ type: "text", text: "output\n\nCommand exited with code 7" }],
			details: { exitCode: 7 },
			isError: true,
		});
		expect(outcome).toEqual({ output: "output", exitCode: 7, timedOut: false, cancelled: false });
		expect(formatRunShellResult(outcome)).toEqual({
			text: '{"stdout": "output", "exit": 7, "__mvi_text_output": "output"}',
			details: { stdout: "output", exit: 7, __mvi_text_output: "output" },
			isError: true,
		});
	});

	test("maps eval language and strips its exit notice", () => {
		const outcome = evalOutcomeFromOmp({
			content: [{ type: "text", text: "trace\n\nCommand exited with code 1" }],
			details: { language: "python", cells: [{ exitCode: 1 }], isError: true },
			isError: true,
		});
		expect(outcome).toEqual({ output: "trace", isError: true, language: "py" });
		expect(formatEvalResult(outcome)).toEqual({
			text: '{"stdout": "trace", "stderr": "", "exit": 1, "result": "", "kernel_reset": false, "output_truncated": false, "__mvi_text_output": "trace"}',
			details: {
				stdout: "trace",
				stderr: "",
				exit: 1,
				result: "",
				kernel_reset: false,
				output_truncated: false,
				__mvi_text_output: "trace",
			},
			isError: true,
		});
	});
});
