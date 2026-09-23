import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isJsonRecord, type CanonicalJson, type JsonRecord } from "../canonical-json";
import { applyPatchOperationsDirect, convertPatchToUnified, normalizeWorkspacePath } from "./patch";
import type { NativeToolResult } from "./types";

export function pythonJson(value: CanonicalJson): string {
	if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
	return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`).join(", ")}}`;
}

function result(details: CanonicalJson, isError = false): NativeToolResult {
	return { text: pythonJson(details), details, ...(isError ? { isError: true } : {}) };
}

/** Mirrors `agent_llm_openai.py:5264-5273`; list filtering follows :5519-5521. */
function privateWorkspacePath(workspaceRoot: string, requested: string): boolean {
	const root = resolve(workspaceRoot);
	const normalized = normalizeWorkspacePath(root, requested);
	const relativePath = relative(root, normalized);
	const parts = relativePath.split(/[\\/]/u).filter(Boolean);
	return parts[0] === ".breadboard" && (parts[1] === "artifacts" || parts[1] === "attachments");
}

function patchTouchesPrivateWorkspace(workspaceRoot: string, patch: string): boolean {
	const pattern = /^(?:\*\*\* (?:Add|Update|Delete) File:|\*\*\* Move to:|---|\+\+\+|(?:rename|copy) (?:from|to))\s+(?:[ab][/])?("?[^"\t\n]+"?)(?:\t.*)?$/gmu;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(patch)) !== null) {
		const requested = match[1]!.trim().replace(/^"+|"+$/gu, "");
		if (privateWorkspacePath(workspaceRoot, requested)) return true;
	}
	return false;
}

function privateTreeEntry(workspaceRoot: string, target: string, entry: CanonicalJson): boolean {
	return isJsonRecord(entry) && typeof entry.path === "string"
		? privateWorkspacePath(workspaceRoot, resolve(target, entry.path))
		: false;
}

function workspacePath(workspaceRoot: string, requested: string): string {
	const root = resolve(workspaceRoot);
	const candidate = resolve(root, requested || ".");
	const rest = relative(root, candidate);
	if (rest === ".." || rest.startsWith("../") || isAbsolute(rest)) throw new Error("path_outside_workspace");
	return candidate;
}

function pathError(workspaceRoot: string, requested: string, extra: JsonRecord): NativeToolResult {
	return result({ path: resolve(workspaceRoot), ...extra, error: "path_outside_workspace" }, true);
}

export async function readFileAdapter(
	workspaceRoot: string,
	input: Readonly<{ path: string; offset?: number; limit?: number }>,
): Promise<NativeToolResult> {
	if (privateWorkspacePath(workspaceRoot, input.path)) {
		return result({ error: "artifact store is private; use an authorized attachment URI" }, true);
	}

	let path: string;
	try {
		path = workspacePath(workspaceRoot, input.path);
	} catch {
		return pathError(workspaceRoot, input.path, { content: "", truncated: false, offset: Math.max(0, Math.trunc(input.offset ?? 0)), limit: input.limit ?? null });
	}
	const offset = Math.max(0, Math.trunc(input.offset ?? 0));
	let raw = "";
	try {
		raw = await readFile(path, "utf8");
	} catch {
		// The Python sandbox deliberately reports inaccessible files as empty reads.
	}
	const chars = Array.from(raw);
	let content = chars.slice(offset).join("");
	let truncated = false;
	if (input.limit !== undefined) {
		const limit = Math.trunc(input.limit);
		if (limit >= 0 && content.length > limit) {
			content = Array.from(content).slice(0, limit).join("");
			truncated = true;
		}
	}
	return result({ path, content, truncated, offset, limit: input.limit ?? null });
}

async function treeEntries(directory: string, depth: number, prefix: string): Promise<CanonicalJson[]> {
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return [];
	}
	entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
	const output: CanonicalJson[] = [];
	for (const entry of entries) {
		const path = `${prefix}${entry.name}`;
		if (entry.isDirectory()) {
			output.push({ path, type: "dir" });
			if (depth > 1) output.push(...(await treeEntries(resolve(directory, entry.name), depth - 1, `${path}/`)));
		} else if (entry.isFile()) {
			output.push({ path, type: "file" });
		}
	}
	return output;
}

export async function listDirAdapter(
	workspaceRoot: string,
	input: Readonly<{ path: string; depth?: number }>,
): Promise<NativeToolResult> {
	let path: string;
	try {
		path = workspacePath(workspaceRoot, input.path);
	} catch {
		return pathError(workspaceRoot, input.path, { entries: [], items: [], tree_format: false });
	}
	const depth = Math.max(1, Math.trunc(input.depth || 1));
	const items = (await treeEntries(path, depth, "")).filter(
		entry => !privateTreeEntry(workspaceRoot, path, entry),
	);
	return result({ path, items, entries: items, tree_format: false });
}
export async function createFileFromBlockAdapter(
	workspaceRoot: string,
	input: Readonly<{ filePath?: string; file_name?: string; content: string }>,
): Promise<NativeToolResult> {
	const requested = input.file_name || input.filePath || "";
	if (privateWorkspacePath(workspaceRoot, requested)) {
		return result({ error: "private workspace storage is unavailable to model tools" }, true);
	}

	let path: string;
	try {
		path = workspacePath(workspaceRoot, requested);
	} catch {
		return result({ ok: false, path: resolve(workspaceRoot), error: "path_outside_workspace" }, true);
	}
	try {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, input.content, "utf8");
		return result({ ok: true, path, bytes: Buffer.byteLength(input.content, "utf8") });
	} catch (error) {
		return result({ ok: false, path, error: error instanceof Error ? error.message : String(error) }, true);
	}
}

function patchPaths(patch: string): string[] {
	const paths: string[] = [];
	for (const line of patch.replaceAll("\r\n", "\n").split("\n")) {
		if (!line.startsWith("--- ") && !line.startsWith("+++ ")) continue;
		let path = line.slice(4).split("\t", 1)[0]!.trim();
		if (path === "/dev/null") continue;
		path = path.replace(/^[ab][/]/u, "");
		paths.push(path);
	}
	return paths;
}

async function git(root: string, args: readonly string[]): Promise<{ exit: number; stdout: string; stderr: string }> {
	const process = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text()]);
	return { exit: await process.exited, stdout, stderr };
}

/** Mirrors `apply_unified_patch` (`agent_llm_openai.py:5579-5617`). */
export async function applyUnifiedPatchAdapter(workspaceRoot: string, patch: string): Promise<NativeToolResult> {
	const root = resolve(workspaceRoot);
	const patchSourceText = patch;
	let patchText = patchSourceText;
	if (patchTouchesPrivateWorkspace(root, patchSourceText)) {
		return result({ error: "private workspace storage is unavailable to model tools" }, true);
	}

	if (
		patchText.includes("*** Add File:")
		|| patchText.includes("*** Update File:")
		|| patchText.includes("*** Delete File:")
		|| patchText.includes("*** Begin Patch")
	) {
		const converted = convertPatchToUnified(patchText);
		if (converted) patchText = converted;
	}
	for (const path of patchPaths(patchSourceText)) {
		if (isAbsolute(path) || path.split(/[\\/]/u).includes("..")) {
			return result({ ok: false, stdout: "", stderr: `error: ${path}: does not exist in index\n` }, true);
		}
	}
	if (!patchText.trim()) return result({ ok: false, error: "empty patch" }, true);
	const refresh = await git(root, ["update-index", "--refresh"]);
	if (refresh.exit !== 0) {
		const fallback = await applyPatchOperationsDirect(root, patchSourceText || patchText);
		if (fallback !== null) return result(fallback, isJsonRecord(fallback) && fallback.ok === false);
		return result({ ok: false, stdout: refresh.stdout, stderr: refresh.stderr }, true);
	}
	const patchPath = resolve(root, `.breadboard_patch_${crypto.randomUUID()}.diff`);
	try {
		await writeFile(patchPath, patchText, "utf8");
		const applied = await git(root, ["apply", "--3way", "--index", "--whitespace=fix", patchPath]);
		if (applied.exit === 0) return result({ ok: true, stdout: applied.stdout, stderr: applied.stderr });
		const fallback = await applyPatchOperationsDirect(root, patchSourceText || patchText);
		if (fallback !== null) return result(fallback, isJsonRecord(fallback) && fallback.ok === false);
		return result({ ok: false, stdout: applied.stdout, stderr: applied.stderr }, true);
	} finally {
		await unlink(patchPath).catch(() => undefined);
	}
}

/** `mark_task_complete` returns the completion action (`agent_llm_openai.py:5656-5657`). */
export function markTaskCompleteAdapter(): NativeToolResult {
	return result({ action: "complete" });
}
