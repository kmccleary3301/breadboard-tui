import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isJsonRecord, type CanonicalJson, type JsonRecord } from "../canonical-json";
import { applyPatchOperationsDirect, convertPatchToUnified, normalizeWorkspacePath, patchTouchedPaths } from "./patch";
import type { NativeToolResult } from "./types";

export function pythonJson(value: CanonicalJson): string {
	if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
	return `{${Object.entries(value)
		.map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`)
		.join(", ")}}`;
}

function result(details: CanonicalJson, isError = false): NativeToolResult {
	return { text: pythonJson(details), details, ...(isError ? { isError: true } : {}) };
}

function resolveSymlinkAware(workspaceRoot: string, path: string): string {
	const lexicalRoot = resolve(workspaceRoot);
	const root = realpathSync.native(lexicalRoot);
	const candidate = resolve(path);
	const rootRelative = relative(lexicalRoot, candidate);
	if (rootRelative === ".." || rootRelative.startsWith("../") || isAbsolute(rootRelative)) return candidate;
	let pending = rootRelative.split(/[\\/]/u).filter(Boolean);
	let current = root;
	while (pending.length > 0) {
		const segment = pending.shift()!;
		const next = resolve(current, segment);
		try {
			current = realpathSync.native(next);
			continue;
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ELOOP") throw error;
			if (!(error instanceof Error) || !("code" in error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR"))
				throw error;
			let stat;
			try {
				stat = lstatSync(next);
			} catch (statError) {
				if (
					statError instanceof Error &&
					"code" in statError &&
					(statError.code === "ENOENT" || statError.code === "ENOTDIR")
				) {
					return resolve(current, segment, ...pending);
				}
				throw statError;
			}
			if (!stat.isSymbolicLink()) return resolve(current, segment, ...pending);
			const target = readlinkSync(next, "utf8");
			const targetPath = resolve(isAbsolute(target) ? target : dirname(next), target);
			const targetRelative = relative(root, targetPath);
			if (targetRelative === ".." || targetRelative.startsWith("../") || isAbsolute(targetRelative)) {
				return resolve(targetPath, ...pending);
			}
			pending = [...targetRelative.split(/[\\/]/u).filter(Boolean), ...pending];
			current = root;
		}
	}
	return current;
}

function workspaceResultPath(workspaceRoot: string, path: string): string {
	const lexicalRoot = resolve(workspaceRoot);
	const resolvedRoot = resolveSymlinkAware(lexicalRoot, lexicalRoot);
	const resolvedPath = resolveSymlinkAware(lexicalRoot, path);
	const lexicalRelative = relative(lexicalRoot, path);
	const resolvedRelative = relative(resolvedRoot, resolvedPath);
	return lexicalRelative === resolvedRelative ? path : resolve(lexicalRoot, resolvedRelative);
}

/** Mirrors `agent_llm_openai.py:5264-5273`; list filtering follows :5519-5521. */
function privateWorkspacePath(workspaceRoot: string, requested: string): boolean {
	const lexicalRoot = resolve(workspaceRoot);
	const root = resolveSymlinkAware(lexicalRoot, lexicalRoot);
	const normalized = normalizeWorkspacePath(lexicalRoot, requested);
	const resolved = resolveSymlinkAware(lexicalRoot, normalized);
	const relativePath = relative(root, resolved);
	const parts = relativePath.split(/[\\/]/u).filter(Boolean);
	return parts[0] === ".breadboard" && (parts[1] === "artifacts" || parts[1] === "attachments");
}
function symlinkResolutionError(error: unknown): NativeToolResult | undefined {
	if (error instanceof Error && "code" in error && error.code === "ELOOP")
		return result({ error: error.message }, true);
	return undefined;
}
function leavesWorkspace(workspaceRoot: string, path: string): boolean {
	const lexicalRoot = resolve(workspaceRoot);
	const resolvedRoot = resolveSymlinkAware(lexicalRoot, lexicalRoot);
	const resolvedPath = resolveSymlinkAware(lexicalRoot, path);
	const relativePath = relative(resolvedRoot, resolvedPath);
	return relativePath === ".." || relativePath.startsWith("../") || isAbsolute(relativePath);
}

function patchTouchesPrivateWorkspace(workspaceRoot: string, patch: string): boolean {
	const pattern =
		/^(?:\*\*\* (?:Add|Update|Delete) File:|\*\*\* Move to:|---|\+\+\+|(?:rename|copy) (?:from|to))\s+(?:[ab][/])?("?[^"\t\n]+"?)(?:\t.*)?$/gmu;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(patch)) !== null) {
		const requested = match[1]!.trim().replace(/^"+|"+$/gu, "");
		if (privateWorkspacePath(workspaceRoot, requested)) return true;
	}
	return false;
}

function privateTreeEntry(workspaceRoot: string, target: string, entry: CanonicalJson): boolean {
	if (!isJsonRecord(entry) || typeof entry.path !== "string") return false;
	const requested = resolve(target, entry.path);
	return leavesWorkspace(workspaceRoot, requested) || privateWorkspacePath(workspaceRoot, requested);
}

function workspacePath(workspaceRoot: string, requested: string): string {
	const root = resolve(workspaceRoot);
	const candidate = resolve(root, requested || ".");
	const rest = relative(root, candidate);
	if (rest === ".." || rest.startsWith("../") || isAbsolute(rest)) throw new Error("path_outside_workspace");
	const resolvedRoot = resolveSymlinkAware(root, root);
	const resolvedPath = resolveSymlinkAware(root, candidate);
	const resolvedRelative = relative(resolvedRoot, resolvedPath);
	return resolvedRelative === ".." || resolvedRelative.startsWith("../") || isAbsolute(resolvedRelative)
		? root
		: resolve(root, resolvedRelative);
}

function pathError(workspaceRoot: string, requested: string, extra: JsonRecord): NativeToolResult {
	return result({ path: resolve(workspaceRoot), ...extra, error: "path_outside_workspace" }, true);
}

export async function readFileAdapter(
	workspaceRoot: string,
	input: Readonly<{ path: string; offset?: number; limit?: number }>,
): Promise<NativeToolResult> {
	try {
		if (privateWorkspacePath(workspaceRoot, input.path)) {
			return result({ error: "artifact store is private; use an authorized attachment URI" }, true);
		}
	} catch (error) {
		const failure = symlinkResolutionError(error);
		if (failure) return failure;
		throw error;
	}

	let path: string;
	try {
		path = workspacePath(workspaceRoot, input.path);
	} catch {
		return pathError(workspaceRoot, input.path, {
			content: "",
			truncated: false,
			offset: Math.max(0, Math.trunc(input.offset ?? 0)),
			limit: input.limit ?? null,
		});
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

async function treeEntries(
	directory: string,
	depth: number,
	prefix: string,
	workspaceRoot: string,
): Promise<CanonicalJson[]> {
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
			if (depth > 1 && !leavesWorkspace(workspaceRoot, resolve(directory, entry.name))) {
				output.push(...(await treeEntries(resolve(directory, entry.name), depth - 1, `${path}/`, workspaceRoot)));
			}
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
	let items: CanonicalJson[];
	try {
		items = (await treeEntries(path, depth, "", workspaceRoot)).filter(
			entry => !privateTreeEntry(workspaceRoot, path, entry),
		);
	} catch (error) {
		const failure = symlinkResolutionError(error);
		if (failure) return failure;
		throw error;
	}
	try {
		return result({ path: workspaceResultPath(workspaceRoot, path), items, entries: items, tree_format: false });
	} catch (error) {
		const failure = symlinkResolutionError(error);
		if (failure) return failure;
		throw error;
	}
}
export async function createFileFromBlockAdapter(
	workspaceRoot: string,
	input: Readonly<{ filePath?: string; file_name?: string; content: string }>,
): Promise<NativeToolResult> {
	const requested = input.file_name || input.filePath || "";
	try {
		if (privateWorkspacePath(workspaceRoot, requested)) {
			return result({ error: "private workspace storage is unavailable to model tools" }, true);
		}
	} catch (error) {
		const failure = symlinkResolutionError(error);
		if (failure) return failure;
		throw error;
	}

	let path: string;
	try {
		path = workspacePath(workspaceRoot, requested);
	} catch {
		return result({ ok: false, path: resolve(workspaceRoot), error: "path_outside_workspace" }, true);
	}
	if (path === resolve(workspaceRoot)) {
		return result({ ok: false, path, error: "workspace_file_path_required" }, true);
	}
	try {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, input.content, "utf8");
		return result({ ok: true, path, bytes: Buffer.byteLength(input.content, "utf8") });
	} catch (error) {
		return result({ ok: false, path, error: error instanceof Error ? error.message : String(error) }, true);
	}
}

async function git(root: string, args: readonly string[]): Promise<{ exit: number; stdout: string; stderr: string }> {
	const process = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	return { exit: await process.exited, stdout, stderr };
}

/** Mirrors `apply_unified_patch` (`agent_llm_openai.py:5579-5617`). */
export async function applyUnifiedPatchAdapter(workspaceRoot: string, patch: string): Promise<NativeToolResult> {
	const root = resolve(workspaceRoot);
	const patchSourceText = patch;
	let patchText = patchSourceText;
	try {
		if (patchTouchesPrivateWorkspace(root, patchSourceText)) {
			return result({ error: "private workspace storage is unavailable to model tools" }, true);
		}
	} catch (error) {
		const failure = symlinkResolutionError(error);
		if (failure) return failure;
		throw error;
	}

	if (
		patchText.includes("*** Add File:") ||
		patchText.includes("*** Update File:") ||
		patchText.includes("*** Delete File:") ||
		patchText.includes("*** Begin Patch")
	) {
		const converted = convertPatchToUnified(patchText);
		if (converted) patchText = converted;
	}
	// The reference has no lexical path guard: git refuses what it cannot apply, and the
	// direct fallback writes where `normalize_workspace_path` points (in-workspace absolute
	// paths kept, `..` popped, outside paths clamped to the root). Check that same target, so a
	// symlink that leaves the workspace is still refused before anything is written.
	for (const path of patchTouchedPaths(patchSourceText)) {
		if (leavesWorkspace(root, normalizeWorkspacePath(root, path))) {
			const stderr = patchSourceText.includes("*** Begin Patch")
				? 'error: No valid patches in input (allow with "--allow-empty")\n'
				: `error: ${path}: Operation not permitted\n`;
			return result({ ok: false, stdout: "", stderr }, true);
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
/** `zeroBasedOffset` follows the pack's declared `offset` contract; host line selectors are 1-indexed. */
export function adaptReadInput(
	input: Record<string, unknown>,
	pathKey = "path",
	zeroBasedOffset = false,
): { path: string | undefined } {
	const rawPath = input[pathKey];
	if (rawPath === undefined || rawPath === null) return { path: undefined };
	let resolvedPath = String(rawPath);
	const offset = input.offset;
	const limit = input.limit;
	if (offset !== undefined || limit !== undefined) {
		const numOffset = typeof offset === "number" ? offset : Number(offset);
		const numLimit = typeof limit === "number" ? limit : Number(limit);
		const hasOffset = !Number.isNaN(numOffset) && offset !== undefined;
		const hasLimit = !Number.isNaN(numLimit) && limit !== undefined;
		const start = hasOffset ? Math.max(1, Math.floor(numOffset) + (zeroBasedOffset ? 1 : 0)) : 1;
		if (hasLimit) {
			resolvedPath = `${resolvedPath}:${start}+${Math.floor(numLimit)}`;
		} else if (hasOffset) {
			resolvedPath = `${resolvedPath}:${start}-`;
		}
	}
	return { path: resolvedPath };
}

/**
 * `glob`: pattern as written. `basename`: pi `find` (fd --glob), where a pattern matches at any depth; fd
 * prefixes `**\/` to slash patterns in full-path mode and matches slash-free ones against file names.
 * `children`: ls-style, one directory level.
 */
export type GlobListingMode = "glob" | "basename" | "children";

function anyDepthPattern(pattern: string): string {
	return pattern.startsWith("/") || pattern.startsWith("**/") || pattern === "**" ? pattern : `**/${pattern}`;
}

export function adaptGlobInput(
	input: Record<string, unknown>,
	pathKey = "path",
	patternKey = "pattern",
	mode: GlobListingMode = "glob",
): { path?: string; hidden?: boolean; gitignore?: boolean; limit?: number } {
	const rawPath = input[pathKey];
	const declaredPattern = input[patternKey];
	const rawPattern =
		mode === "children"
			? "*"
			: mode === "basename" && declaredPattern !== undefined
				? anyDepthPattern(String(declaredPattern))
				: declaredPattern;
	let combinedPath: string | undefined;
	if (rawPath !== undefined && rawPattern !== undefined && !String(rawPattern).startsWith("/")) {
		const p = String(rawPath).replace(/\/+$/, "");
		combinedPath = p.length > 0 && p !== "." ? `${p}/${String(rawPattern)}` : String(rawPattern);
	} else if (rawPattern !== undefined) {
		combinedPath = String(rawPattern);
	} else if (rawPath !== undefined) {
		combinedPath = String(rawPath);
	}
	// Host glob expands a leading bare `*` to `**/*`; anchoring at `.` keeps a children listing one level deep.
	if (mode === "children" && combinedPath === "*") combinedPath = "./*";
	const out: { path?: string; hidden?: boolean; gitignore?: boolean; limit?: number } = {};
	if (combinedPath !== undefined) out.path = combinedPath;
	if (input.hidden !== undefined)
		out.hidden = typeof input.hidden === "boolean" ? input.hidden : Boolean(input.hidden);
	if (input.gitignore !== undefined)
		out.gitignore = typeof input.gitignore === "boolean" ? input.gitignore : Boolean(input.gitignore);
	if (input.limit !== undefined) {
		const num = typeof input.limit === "number" ? input.limit : Number(input.limit);
		out.limit = !Number.isNaN(num) ? num : (input.limit as number);
	}
	return out;
}

export function adaptGrepInput(
	input: Record<string, unknown>,
	pathKey = "path",
	includeKey?: string,
): { pattern: string; path?: string; case?: boolean; gitignore?: boolean; skip?: number | null } {
	const rawPattern = input.pattern !== undefined ? String(input.pattern) : "";
	const rawPath = input[pathKey];
	const rawInclude = includeKey ? input[includeKey] : (input.include ?? input.glob);
	let combinedPath: string | undefined;
	if (rawPath !== undefined && rawInclude !== undefined) {
		const p = String(rawPath).replace(/\/+$/, "");
		const include = String(rawInclude);
		// Pack `include` filters match at any depth (ripgrep `--glob`). Host grep scopes `dir/*.ts` to `dir`
		// itself, so a slash-free filter under a path becomes `dir/**/*.ts`.
		const scoped = include.includes("/") ? include : `**/${include}`;
		combinedPath = p.length > 0 && p !== "." ? `${p}/${scoped}` : include;
	} else if (rawInclude !== undefined) {
		combinedPath = String(rawInclude);
	} else if (rawPath !== undefined) {
		combinedPath = String(rawPath);
	}
	// Host grep takes a regex only; a declared literal pattern is escaped to match itself.
	const pattern = input.literal === true ? rawPattern.replace(/[\\^$.*+?()[\]{}|#&~-]/gu, "\\$&") : rawPattern;
	const out: { pattern: string; path?: string; case?: boolean; gitignore?: boolean; skip?: number | null } = {
		pattern,
	};
	if (combinedPath !== undefined) out.path = combinedPath;
	if (input.case !== undefined) {
		out.case = typeof input.case === "boolean" ? input.case : Boolean(input.case);
	} else if (input.ignoreCase !== undefined) {
		out.case = typeof input.ignoreCase === "boolean" ? !input.ignoreCase : false;
	} else if (input["-i"] !== undefined) {
		out.case = typeof input["-i"] === "boolean" ? !input["-i"] : false;
	}
	if (input.gitignore !== undefined)
		out.gitignore = typeof input.gitignore === "boolean" ? input.gitignore : Boolean(input.gitignore);
	if (input.skip !== undefined) {
		const num = typeof input.skip === "number" ? input.skip : Number(input.skip);
		out.skip = !Number.isNaN(num) ? num : (input.skip as number | null);
	}
	return out;
}

export function adaptSkillInput(input: Record<string, unknown>, skillKey = "skill"): { path: string } {
	const name = input[skillKey] ?? input.skill ?? input.name ?? "";
	return { path: `skill://${String(name)}` };
}

export function adaptTaskInput(
	input: Record<string, unknown>,
	isSingleTask = true,
): { context: string; tasks: Array<Record<string, unknown>> } {
	if (!isSingleTask && Array.isArray(input.tasks)) {
		return {
			context: typeof input.context === "string" ? input.context : String(input.context ?? ""),
			tasks: input.tasks as Array<Record<string, unknown>>,
		};
	}
	const taskPrompt = input.prompt ?? input.task ?? "";
	const description = input.description ?? input.name ?? "";
	// Single-task packs name their own product's agent roles (general, explore, oracle, ...), none of which
	// are host agents. The host default agent runs the task; the requested role stays visible in context.
	const role = input.subagent_type ?? input.agent;
	const baseContext = typeof input.context === "string" ? input.context : String(description || taskPrompt);
	const context =
		role === undefined || role === "" ? baseContext : `${baseContext}\nRequested agent role: ${String(role)}`;
	// Single-task packs carry no solution-space field. Host `task` requires one; a blank value makes its
	// auto-thinking classifier fall back to the task text, the same as omitting it.
	return {
		context,
		tasks: [{ task: String(taskPrompt), name: String(description), solutionSpace: "" }],
	};
}

export interface BashInputShape {
	/** Declared command key; `tmux_command` carries tmux arguments (`new-session -d -s x`), not a shell line. */
	readonly commandKey: string;
	readonly timeoutKey?: string;
	/** Host bash timeouts are seconds; packs declaring milliseconds are converted. */
	readonly timeoutInMilliseconds: boolean;
	readonly cwdKey?: string;
	/** Declared keys that are also host bash parameters with the same meaning (`async`, `pty`, ...). */
	readonly passthroughKeys: readonly string[];
}

export function adaptBashInput(input: Record<string, unknown>, shape: BashInputShape): Record<string, unknown> {
	const rawCommand = String(input[shape.commandKey] ?? "");
	const out: Record<string, unknown> = {
		command:
			shape.commandKey === "tmux_command" ? `tmux ${rawCommand.trim().replace(/^tmux(\s+|$)/u, "")}` : rawCommand,
	};
	const rawTimeout = shape.timeoutKey === undefined ? undefined : input[shape.timeoutKey];
	if (rawTimeout !== undefined && rawTimeout !== null) {
		const timeout = Number(rawTimeout);
		if (shape.timeoutInMilliseconds) {
			if (timeout > 0) out.timeout = Math.max(1, Math.ceil(timeout / 1000));
		} else if (!Number.isNaN(timeout)) {
			out.timeout = timeout;
		}
	}
	const cwd = shape.cwdKey === undefined ? undefined : input[shape.cwdKey];
	if (cwd !== undefined && cwd !== null) out.cwd = cwd;
	for (const key of shape.passthroughKeys) {
		if (input[key] !== undefined) out[key] = input[key];
	}
	return out;
}
