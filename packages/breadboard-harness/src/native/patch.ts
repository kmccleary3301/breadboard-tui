import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { isJsonRecord, type CanonicalJson, type JsonRecord } from "../canonical-json";

type PatchChange = {
	kind: "keep" | "add" | "remove";
	content: string;
};

type PatchHunk = {
	changes: PatchChange[];
	isEndOfFile: boolean;
};

type PatchOperation = {
	kind: "add" | "update" | "delete";
	filePath: string;
	hunks?: PatchHunk[];
	content?: string;
	moveTo?: string;
};

function splitLines(text: string): string[] {
	const lines = text.split(/\r\n|\n|\r/u);
	if (lines.at(-1) === "" && /(?:\r\n|\n|\r)$/u.test(text)) lines.pop();
	return lines;
}

function normalizeBlankHunkLines(patchText: string): string {
	const lines = splitLines(String(patchText || ""));
	let inHunk = false;
	const normalized = lines.map(line => {
		if (line.startsWith("*** ")) {
			inHunk = false;
			return line;
		}
		if (line.startsWith("@@")) {
			inHunk = true;
			return line;
		}
		if (inHunk && line === "") return " ";
		return line;
	});
	return normalized.join("\n") + (patchText.endsWith("\n") || patchText.endsWith("\r") ? "\n" : "");
}

/** Mirrors `breadboard_engine/conductor/patching.py:68-113`. */
export function normalizePatchBlock(patchText: string): string {
	let content = (patchText || "").trim();
	if (!content) return "";
	if (content.startsWith("{") && content.includes('"input"')) {
		try {
			const parsed = JSON.parse(content) as CanonicalJson;
			if (isJsonRecord(parsed)) {
				const nested = parsed.patch ?? parsed.input;
				if (typeof nested === "string" && nested.trim()) content = nested.trim();
			}
		} catch {
			// The Python implementation ignores malformed JSON wrappers.
		}
	}
	content = content.replace(/(\*\*\* (?:Add|Update|Delete) File:[^\n]*?)\s*\*+\s*$/gmu, "$1");
	if (content.includes("*** Begin Patch")) {
		let normalized = content;
		normalized = normalized.replace(/\*\*\* Begin Patch[^\n]*/u, "*** Begin Patch");
		normalized = normalized.replace(/\*\*\* End Patch[^\n]*/u, "*** End Patch");
		normalized = normalizeBlankHunkLines(normalized);
		return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
	}
	return normalizeBlankHunkLines(`*** Begin Patch\n${content}\n*** End Patch\n`);
}

function patchBlocks(text: string): string[] {
	const blocks: string[] = [];
	const pattern = /\*\*\* Begin Patch[\t ]*\r?\n([\s\S]*?)\*\*\* End Patch/gm;
	for (const match of text.matchAll(pattern)) blocks.push(match[1] ?? "");
	if (text.trim() && blocks.length === 0) throw new Error("No *** Begin Patch ... *** End Patch block found");
	return blocks;
}

/** Mirrors `breadboard/opencode_patch.py:48-164`. */
function parseStructuredPatch(text: string): PatchOperation[] {
	const operations: PatchOperation[] = [];
	for (const block of patchBlocks(text)) {
		const lines = splitLines(block);
		let index = 0;
		const at = (position: number): string => lines[position] ?? "";
		while (index < lines.length) {
			const line = at(index);
			if (!line.trim()) {
				index++;
				continue;
			}
			if (line.startsWith("*** Add File: ")) {
				const filePath = line.slice("*** Add File: ".length).trim();
				index++;
				const contentLines: string[] = [];
				while (index < lines.length) {
					const current = at(index);
					if (current.startsWith("*** ")) break;
					if (current.startsWith("+")) contentLines.push(current.slice(1));
					else if (current === "") contentLines.push("");
					else throw new Error(`Unexpected line in Add File ${filePath}: ${JSON.stringify(current)}`);
					index++;
				}
				const content = contentLines.length ? `${contentLines.join("\n")}\n` : "";
				operations.push({ kind: "add", filePath, content, hunks: [] });
				continue;
			}
			if (line.startsWith("*** Delete File: ")) {
				const filePath = line.slice("*** Delete File: ".length).trim();
				operations.push({ kind: "delete", filePath, hunks: [] });
				index++;
				continue;
			}
			if (line.startsWith("*** Update File: ")) {
				const filePath = line.slice("*** Update File: ".length).trim();
				index++;
				let moveTo: string | undefined;
				const hunks: PatchHunk[] = [];
				let currentChanges: PatchChange[] | undefined;
				let currentEndOfFile = false;
				const flushHunk = (): void => {
					if (!currentChanges) return;
					if (currentChanges.length === 0) throw new Error(`Empty hunk in Update File ${filePath}`);
					hunks.push({ changes: currentChanges, isEndOfFile: currentEndOfFile });
					currentChanges = undefined;
					currentEndOfFile = false;
				};
				while (index < lines.length) {
					const current = at(index);
					if (current.startsWith("@@")) {
						flushHunk();
						currentChanges = [];
						index++;
						continue;
					}
					if (current.startsWith("*** Move to: ")) {
						moveTo = current.slice("*** Move to: ".length).trim();
						index++;
						continue;
					}
					if (current.trim() === "*** End of File") {
						currentEndOfFile = true;
						index++;
						continue;
					}
					if (current.startsWith("*** ")) break;
					if (current === "") {
						if (!currentChanges) currentChanges = [];
						currentChanges.push({ kind: "keep", content: "" });
						index++;
						continue;
					}
					if (current[0] === " " || current[0] === "+" || current[0] === "-") {
						if (!currentChanges) currentChanges = [];
						const kinds = { " ": "keep", "+": "add", "-": "remove" } as const;
						currentChanges.push({ kind: kinds[current[0] as keyof typeof kinds], content: current.slice(1) });
						index++;
						continue;
					}
					throw new Error(`Unexpected line in Update File ${filePath}: ${JSON.stringify(current)}`);
				}
				flushHunk();
				operations.push({ kind: "update", filePath, hunks, moveTo });
				continue;
			}
			throw new Error(`Unexpected patch line: ${JSON.stringify(line)}`);
		}
	}
	return operations;
}
export function patchTouchedPaths(patchText: string): string[] {
	const normalized = normalizePatchBlock(patchText);
	if (!normalized) return [];
	try {
		const operations = parseStructuredPatch(normalized);
		if (operations.length > 0) {
			return operations.flatMap(operation => [operation.filePath, ...(operation.moveTo ? [operation.moveTo] : [])]);
		}
	} catch {
		// Fall through to unified-diff headers.
	}
	const paths: string[] = [];
	for (const line of splitLines(normalized)) {
		if (line.startsWith("diff --git ")) {
			const fields = line.slice("diff --git ".length).trim().split(/\s+/u);
			for (const field of fields) if (field.startsWith("a/") || field.startsWith("b/")) paths.push(field.slice(2));
		} else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
			let path = line.slice(4).split("\t", 1)[0]!.trim();
			if (path !== "/dev/null") {
				if (path.startsWith("a/") || path.startsWith("b/")) path = path.slice(2);
				paths.push(path);
			}
		} else if (/^(?:rename|copy) (?:from|to) /u.test(line)) {
			paths.push(line.replace(/^(?:rename|copy) (?:from|to) /u, "").trim());
		}
	}
	return [...new Set(paths)];
}

function normalizePatchLine(text: string): string {
	return text.normalize("NFKD").replaceAll("—", "-").replaceAll("–", "-").replaceAll("−", "-").replace(/\s+$/u, "");
}

function seekPatchSequence(lines: readonly string[], target: readonly string[], eof: boolean): number | undefined {
	if (target.length === 0) return eof ? lines.length : 0;
	const haystack = lines.map(normalizePatchLine);
	const needle = target.map(normalizePatchLine);
	if (eof) {
		for (let index = haystack.length - needle.length; index >= 0; index--) {
			if (haystack.slice(index, index + needle.length).every((line, offset) => line === needle[offset]))
				return index;
		}
		return undefined;
	}
	for (let index = 0; index <= haystack.length - needle.length; index++) {
		if (haystack.slice(index, index + needle.length).every((line, offset) => line === needle[offset])) return index;
	}
	return undefined;
}

/** Mirrors `breadboard/opencode_patch.py:226-252`. */
function applyUpdateHunks(original: string, hunks: readonly PatchHunk[], fileLabel: string): string {
	let lines = (original || "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
	for (const hunk of hunks) {
		const before: string[] = [];
		const after: string[] = [];
		for (const change of hunk.changes) {
			if (change.kind === "keep") {
				before.push(change.content);
				after.push(change.content);
			} else if (change.kind === "remove") before.push(change.content);
			else if (change.kind === "add") after.push(change.content);
			else throw new Error(`Unknown change kind in ${fileLabel}`);
		}
		const index = seekPatchSequence(lines, before, hunk.isEndOfFile);
		if (index === undefined) throw new Error(`Failed to apply patch hunk in ${fileLabel}: context not found`);
		lines = [...lines.slice(0, index), ...after, ...lines.slice(index + before.length)];
	}
	return lines.join("\n");
}

/** Mirrors `breadboard_engine/conductor/patching.py:116-172`; paths outside clamp to workspace. */
export function normalizeWorkspacePath(workspaceRoot: string, pathIn: string): string {
	const workspace = resolve(workspaceRoot);
	if (!pathIn) return workspace;
	const raw = String(pathIn).trim();
	if (!raw) return workspace;
	if (isAbsolute(raw)) {
		const candidate = resolve(raw);
		const rest = relative(workspace, candidate);
		return rest === ".." || rest.startsWith("../") || isAbsolute(rest) ? workspace : candidate;
	}
	let normalized = raw.replaceAll("\\", "/");
	while (normalized.startsWith("./")) normalized = normalized.slice(2);
	if (!normalized || normalized === ".") return workspace;
	let segments = normalized.split("/").filter(segment => segment && segment !== ".");
	while (segments[0] === workspace.split("/").at(-1)) segments = segments.slice(1);
	const workspaceNormalized = workspace.replaceAll("\\", "/");
	if (workspaceNormalized && normalized.includes(workspaceNormalized)) {
		segments = normalized
			.split(workspaceNormalized, 2)[1]!
			.replace(/^[/\\]+/u, "")
			.split("/")
			.filter(segment => segment && segment !== ".");
	} else {
		const withoutLeadingSlash = workspaceNormalized.replace(/^\//u, "");
		if (withoutLeadingSlash && normalized.startsWith(withoutLeadingSlash)) {
			segments = normalized
				.slice(withoutLeadingSlash.length)
				.replace(/^[/\\]+/u, "")
				.split("/")
				.filter(segment => segment && segment !== ".");
		}
	}
	const cleaned: string[] = [];
	for (const segment of segments) {
		if (segment === "..") {
			if (cleaned.length) cleaned.pop();
			continue;
		}
		cleaned.push(segment);
	}
	const candidate = resolve(workspace, ...cleaned);
	const rest = relative(workspace, candidate);
	return rest === ".." || rest.startsWith("../") || isAbsolute(rest) ? workspace : candidate;
}

async function fetchWorkspaceText(workspaceRoot: string, path: string): Promise<string> {
	try {
		return await readFile(normalizeWorkspacePath(workspaceRoot, path), "utf8");
	} catch {
		return "";
	}
}

/** `to_unified_diff` is currently a recovery stub (`breadboard/opencode_patch.py:255-260`). */
export function convertPatchToUnified(patchText: string): string | null {
	const normalized = normalizePatchBlock(patchText);
	return normalized || null;
}

async function addToVcs(workspaceRoot: string): Promise<void> {
	try {
		const process = Bun.spawn(["git", "add", "-A"], { cwd: workspaceRoot, stdout: "ignore", stderr: "ignore" });
		await process.exited;
	} catch {
		// Python's conductor.vcs add is deliberately best effort.
	}
}

/** Mirrors `breadboard_engine/conductor/patching.py:202-345`. */
export async function applyPatchOperationsDirect(workspaceRoot: string, patchText: string): Promise<JsonRecord | null> {
	const normalized = normalizePatchBlock(patchText);
	if (!normalized) return null;
	const appliedPaths: string[] = [];
	const patchFailure = (message: string, relativePath = ""): JsonRecord => {
		const detail = relativePath ? `${message} in ${relativePath}` : message;
		return {
			ok: false,
			action: "apply_patch",
			exit: 1,
			stdout: "",
			stderr: `patch did not apply: ${detail}`,
			data: { manual_fallback: true, reason: detail },
		};
	};
	const writePatchFile = async (relativePath: string, content: string): Promise<boolean> => {
		if (!relativePath) return false;
		const absolutePath = normalizeWorkspacePath(workspaceRoot, relativePath);
		try {
			await mkdir(resolve(absolutePath, ".."), { recursive: true });
			await writeFile(absolutePath, content, "utf8");
			appliedPaths.push(relativePath);
			return true;
		} catch {
			return false;
		}
	};
	const deletePatchFile = async (relativePath: string): Promise<boolean> => {
		if (!relativePath) return false;
		try {
			await rm(normalizeWorkspacePath(workspaceRoot, relativePath), { force: true });
			return true;
		} catch {
			return false;
		}
	};
	let operations: PatchOperation[] = [];
	try {
		operations = parseStructuredPatch(normalized);
	} catch {
		operations = [];
	}
	if (operations.length > 0) {
		for (const operation of operations) {
			const relativePath = operation.filePath.trim();
			if (!relativePath) return patchFailure("missing file path");
			if (operation.kind === "add") {
				if (!(await writePatchFile(relativePath, operation.content || "")))
					return patchFailure("write failed", relativePath);
				continue;
			}
			if (operation.kind === "delete") {
				if (!(await deletePatchFile(relativePath))) return patchFailure("delete failed", relativePath);
				continue;
			}
			const original = await fetchWorkspaceText(workspaceRoot, relativePath);
			let updated: string;
			try {
				updated = applyUpdateHunks(original, operation.hunks || [], relativePath);
			} catch (error) {
				return patchFailure(error instanceof Error ? error.message : String(error), relativePath);
			}
			const target = (operation.moveTo || relativePath).trim();
			if (!target) return patchFailure("missing target path", relativePath);
			if (!(await writePatchFile(target, updated))) return patchFailure("write failed", target);
			if (target !== relativePath && !(await deletePatchFile(relativePath)))
				return patchFailure("delete failed", relativePath);
		}
	}
	if (operations.length === 0) {
		const diffAdds: Array<[string, string]> = [];
		let current: { path: string | null; isNew: boolean; collect: boolean; lines: string[] } | null = null;
		const flush = (): void => {
			if (current?.isNew && current.path && current.lines.length > 0)
				diffAdds.push([current.path, current.lines.join("\n").replace(/\n+$/u, "")]);
		};
		for (const line of splitLines(patchText)) {
			if (line.startsWith("diff --git ")) {
				flush();
				current = { path: null, isNew: false, collect: false, lines: [] };
			}
			if (!current) continue;
			if (line.startsWith("--- ")) {
				if (line.trim() === "--- /dev/null") current.isNew = true;
			} else if (line.startsWith("+++ ")) {
				let path = line.slice(4).trim();
				if (path.startsWith("a/") || path.startsWith("b/")) path = path.slice(2);
				current.path = path;
			} else if (line.startsWith("@@")) current.collect = true;
			else if (current.collect && line.startsWith("+") && !line.startsWith("+++")) current.lines.push(line.slice(1));
		}
		flush();
		for (const [relativePath, content] of diffAdds) {
			if (!(await writePatchFile(relativePath, content))) return patchFailure("write failed", relativePath);
		}
	}
	if (appliedPaths.length === 0) return null;
	await addToVcs(workspaceRoot);
	return {
		ok: true,
		action: "apply_patch",
		exit: 0,
		stdout: "",
		stderr: "",
		data: { manual_fallback: true, paths: appliedPaths },
	};
}
