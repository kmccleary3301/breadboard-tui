import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { CanonicalJson } from "../canonical-json";
import type { NativeToolResult } from "./types";

function pythonJson(value: CanonicalJson): string {
	if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
	return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`).join(", ")}}`;
}

function result(details: CanonicalJson, isError = false): NativeToolResult {
	return { text: pythonJson(details), details, ...(isError ? { isError: true } : {}) };
}

function workspacePath(workspaceRoot: string, requested: string): string {
	const root = resolve(workspaceRoot);
	const candidate = resolve(root, requested || ".");
	const rest = relative(root, candidate);
	if (rest === ".." || rest.startsWith("../") || isAbsolute(rest)) throw new Error("path_outside_workspace");
	return candidate;
}

function pathError(workspaceRoot: string, requested: string, extra: Record<string, CanonicalJson>): NativeToolResult {
	return result({ path: resolve(workspaceRoot), ...extra, error: "path_outside_workspace" }, true);
}

export async function readFileAdapter(
	workspaceRoot: string,
	input: Readonly<{ path: string; offset?: number; limit?: number }>,
): Promise<NativeToolResult> {
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
	const items = await treeEntries(path, depth, "");
	return result({ path, items, entries: items, tree_format: false });
}

export async function createFileFromBlockAdapter(
	workspaceRoot: string,
	input: Readonly<{ filePath?: string; file_name?: string; content: string }>,
): Promise<NativeToolResult> {
	const requested = input.file_name || input.filePath || "";
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

export async function applyUnifiedPatchAdapter(workspaceRoot: string, patch: string): Promise<NativeToolResult> {
	const root = resolve(workspaceRoot);
	for (const path of patchPaths(patch)) {
		if (isAbsolute(path) || path.split(/[\\/]/u).includes("..")) {
			return result({ ok: false, stdout: "", stderr: `error: ${path}: does not exist in index\n` }, true);
		}
	}
	const refresh = await git(root, ["update-index", "--refresh"]);
	if (refresh.exit !== 0) return result({ ok: false, stdout: refresh.stdout, stderr: refresh.stderr }, true);
	const patchPath = resolve(root, `.breadboard_patch_${crypto.randomUUID()}.diff`);
	try {
		await writeFile(patchPath, patch, "utf8");
		const applied = await git(root, ["apply", "--3way", "--index", "--whitespace=fix", patchPath]);
		return result({ ok: applied.exit === 0, stdout: applied.stdout, stderr: applied.stderr }, applied.exit !== 0);
	} finally {
		await unlink(patchPath).catch(() => undefined);
	}
}

export async function assertWorkspacePath(workspaceRoot: string, requested: string): Promise<string> {
	const path = workspacePath(workspaceRoot, requested);
	await stat(path);
	return path;
}
