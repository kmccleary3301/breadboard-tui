import { pythonJson } from "./adapters";
import type { JsonRecord } from "../canonical-json";
import type { NativeToolResult } from "./types";

/** The OMP outcome fields needed to project one completed bash invocation. */
export interface RunShellOutcome {
	readonly output: string;
	readonly exitCode: number | undefined;
	readonly timedOut: boolean;
	/** OMP bash throws before returning a result for user/system cancellation. */
	readonly cancelled: boolean;
}

/** The OMP outcome fields needed to project one completed eval invocation. */
export interface EvalOutcome {
	readonly output: string;
	readonly isError: boolean;
	readonly language: "py" | "js";
}

/** A small structural view of an OMP text content block. */
export interface OmpTextContent {
	readonly type: string;
	readonly text?: string;
}

/** Structural view of the details returned by OMP's bash tool. */
export interface OmpBashDetails {
	readonly exitCode?: number;
	readonly timedOut?: boolean;
	readonly wallTimeMs?: number;
	readonly timeoutSeconds?: number;
	readonly requestedTimeoutSeconds?: number;
}

/** Structural view of the completed OMP bash AgentToolResult. */
export interface OmpBashToolResult {
	readonly content: readonly OmpTextContent[];
	readonly details?: OmpBashDetails;
	readonly isError?: boolean;
}

/** Structural view of one OMP eval cell's execution details. */
export interface OmpEvalCell {
	readonly exitCode?: number;
}

/** Structural view of the details returned by OMP's eval tool. */
export interface OmpEvalDetails {
	readonly language?: "python" | "py" | "js";
	readonly cells?: readonly OmpEvalCell[];
	readonly isError?: boolean;
}

/** Structural view of the completed OMP eval AgentToolResult. */
export interface OmpEvalToolResult {
	readonly content: readonly OmpTextContent[];
	readonly details?: OmpEvalDetails;
	readonly isError?: boolean;
}

function result(details: JsonRecord, isError = false): NativeToolResult {
	return { text: pythonJson(details), details, ...(isError ? { isError: true } : {}) };
}

function textContent(content: readonly OmpTextContent[]): string {
	return content
		.filter(part => part.type === "text" && typeof part.text === "string")
		.map(part => part.text ?? "")
		.join("\n");
}

function stripSuffix(text: string, suffix: string): string {
	if (!text.endsWith(suffix)) return text;
	const prefix = text.slice(0, -suffix.length);
	if (prefix.endsWith("\n\n")) return prefix.slice(0, -2);
	if (prefix.endsWith("\n")) return prefix.slice(0, -1);
	return prefix;
}

function stripTimeoutNotice(text: string): string {
	const marker = /\[Command timed out[^\]\r\n]*\]/u;
	const exact = text.match(new RegExp(`^${marker.source}$`, "u"));
	if (exact !== null) return "";
	const leading = text.match(new RegExp(`^${marker.source}\\r?\\n`, "u"));
	if (leading !== null) return text.slice(leading[0].length);
	const trailing = text.match(new RegExp(`\\r?\\n(?:\\r?\\n)?${marker.source}$`, "u"));
	if (trailing !== null) return text.slice(0, -trailing[0].length);
	return text;
}

function stripBashNotices(output: string, details: OmpBashDetails | undefined): string {
	let text = output;
	if (details?.wallTimeMs !== undefined) {
		text = stripSuffix(text, `Wall time: ${(details.wallTimeMs / 1000).toFixed(2)} seconds`);
	}
	if (details?.exitCode !== undefined && details.exitCode !== 0) {
		text = stripSuffix(text, `Command exited with code ${details.exitCode}`);
	}
	if (details?.timedOut === true) text = stripTimeoutNotice(text);
	return text === "(no output)" ? "" : text;
}

function stripEvalNotices(output: string, details: OmpEvalDetails | undefined, isError: boolean): string {
	let text = output;
	const exitCode = details?.cells?.at(-1)?.exitCode;
	if (exitCode !== undefined && exitCode !== 0) {
		text = stripSuffix(text, `Command exited with code ${exitCode}`);
	} else if (isError) {
		text = text.replace(/\n\nCommand exited with code \d+$/u, "");
	}
	return text === "(no output)" ? "" : text;
}

/**
 * Convert OMP's completed bash result into the R39 run_shell input shape.
 *
 * OMP exposes one combined `content[].text` stream, not separate stdout/stderr,
 * and appends wall-time, exit-code, and timeout notices. We remove those known
 * OMP notices. Python's run_shell timeout path (`sandbox.py:463-493`) returns
 * exit 124 and stderr `Command timed out`; that synthesized stderr is retained
 * below because OMP has no separate stderr field. OMP cancellation throws from
 * `bash.ts:#throwIfUnfinished` (`bash.ts:753-776`) and therefore never reaches
 * this mapper; no cancelled result is fabricated here.
 */
export function runShellOutcomeFromBash(result: OmpBashToolResult): RunShellOutcome {
	const details = result.details;
	const timedOut = details?.timedOut === true;
	const output = stripBashNotices(textContent(result.content), details);
	const exitCode = timedOut ? 124 : (details?.exitCode ?? (result.isError ? 1 : 0));
	return { output, exitCode, timedOut, cancelled: false };
}

/**
 * Convert OMP's completed eval result into the R39 eval input shape.
 *
 * OMP exposes rendered cell text and an error bit; it does not expose the
 * Python result's separate stdout/stderr/result, kernel-reset, or truncation
 * fields. The formatter preserves the rendered text and uses the language and
 * error bit available from OMP; missing Python-only fields are represented by
 * their reference defaults. OMP's `Command exited with code N` and `(no
 * output)` presentation notices are removed before projection.
 */
export function evalOutcomeFromOmp(result: OmpEvalToolResult): EvalOutcome {
	const details = result.details;
	const language = details?.language;
	if (language !== "py" && language !== "python" && language !== "js") {
		throw new Error("OMP eval result does not identify its language");
	}
	const isError = result.isError === true || details?.isError === true;
	return {
		output: stripEvalNotices(textContent(result.content), details, isError),
		isError,
		language: language === "python" ? "py" : language,
	};
}

/**
 * Render one OMP bash outcome with the Python run_shell keys. OMP cannot
 * provide Python's raw stderr separately; only timeout synthesizes the exact
 * Python sandbox marker. `cancelled` is intentionally ignored because OMP
 * cancellation throws instead of returning an AgentToolResult.
 */
export function formatRunShellResult(omp: RunShellOutcome): NativeToolResult {
	const stderr = omp.timedOut ? "Command timed out" : "";
	const visible =
		stderr && (omp.output.length > 0 || omp.exitCode !== 0) ? [omp.output, stderr].join("\n") : omp.output || stderr;
	const details: JsonRecord = {
		stdout: omp.output,
		exit: omp.exitCode ?? null,
		__mvi_text_output: visible,
	};
	if (stderr) details.stderr = stderr;
	return result(details, omp.timedOut || (omp.exitCode !== undefined && omp.exitCode !== 0));
}

/**
 * OMP cannot supply separate stderr or a rich result value. It can only expose
 * kernel-reset/truncation as trailing visible marker text, so those markers are
 * split from stdout when present; otherwise their Python-only fields default to
 * false. The rendered text remains the model-facing `__mvi_text_output`.
 */
export function formatEvalResult(omp: EvalOutcome): NativeToolResult {
	const kernelReset = omp.output.endsWith("kernel state reset");
	const outputTruncated = omp.output.endsWith("evaluation output truncated");
	const stdout = kernelReset
		? omp.output.slice(0, -"kernel state reset".length)
		: outputTruncated
			? omp.output.slice(0, -"evaluation output truncated".length)
			: omp.output;
	const details: JsonRecord = {
		stdout,
		stderr: "",
		exit: omp.isError ? 1 : 0,
		result: "",
		kernel_reset: kernelReset,
		output_truncated: outputTruncated,
		__mvi_text_output: omp.output,
	};
	return result(details, omp.isError);
}
