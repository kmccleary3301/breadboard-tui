import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { CanonicalJson } from "../canonical-json";
import type { NativeToolResult } from "./types";

function result(text: string, details?: CanonicalJson): NativeToolResult {
	return details === undefined ? { text } : { text, details };
}

function workspacePath(workspaceRoot: string, requested: string): string {
	if (requested.length === 0) throw new Error("path must be non-empty");
	const root = resolve(workspaceRoot);
	const candidate = resolve(root, requested);
	const rest = relative(root, candidate);
	if (rest === ".." || rest.startsWith(`..${"/"}`) || isAbsolute(rest)) throw new Error(`path escapes workspace: ${requested}`);
	return candidate;
}

export async function readFileAdapter(
	workspaceRoot: string,
	input: Readonly<{ path: string; offset?: number; limit?: number }>,
): Promise<NativeToolResult> {
	const path = workspacePath(workspaceRoot, input.path);
	const content = await readFile(path, "utf8");
	const lines = content.split("\n");
	const offset = input.offset === undefined ? 0 : Math.max(0, Math.trunc(input.offset));
	const selected = input.limit === undefined ? lines.slice(offset) : lines.slice(offset, offset + Math.max(0, Math.trunc(input.limit)));
	const output = selected.join("\n");
	return result(output, { path: input.path, content: output, offset, limit: input.limit ?? null });
}

async function treeEntries(root: string, directory: string, depth: number, prefix: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	entries.sort((left, right) => left.name.localeCompare(right.name));
	const resultEntries: string[] = [];
	for (const entry of entries) {
		const name = `${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`;
		resultEntries.push(name);
		if (entry.isDirectory() && depth > 1) resultEntries.push(...(await treeEntries(root, resolve(directory, entry.name), depth - 1, `${prefix}${entry.name}/`)));
	}
	return resultEntries;
}

export async function listDirAdapter(
	workspaceRoot: string,
	input: Readonly<{ path: string; depth?: number }>,
): Promise<NativeToolResult> {
	const path = workspacePath(workspaceRoot, input.path);
	const depth = Math.min(5, Math.max(1, Math.trunc(input.depth ?? 1)));
	const entries = await treeEntries(workspaceRoot, path, depth, "");
	return result(entries.join("\n"), { path: input.path, items: entries, depth });
}

export async function createFileFromBlockAdapter(
	workspaceRoot: string,
	input: Readonly<{ filePath?: string; file_name?: string; content: string }>,
): Promise<NativeToolResult> {
	const requested = input.filePath ?? input.file_name;
	if (requested === undefined || requested.length === 0) throw new Error("filePath or file_name is required");
	const path = workspacePath(workspaceRoot, requested);
	await mkdir(resolve(path, ".."), { recursive: true });
	await writeFile(path, input.content, "utf8");
	return result(`Created ${requested}`, { path: requested, bytes: Buffer.byteLength(input.content) });
}

interface PatchFile {
	readonly path: string;
	readonly hunks: readonly PatchHunk[];
}
interface PatchHunk {
	readonly oldStart: number;
	readonly oldCount: number;
	readonly oldLines: readonly string[];
	readonly newLines: readonly string[];
}

function patchPath(value: string): string {
	const stripped = value.replace(/^[ab][/]/u, "").trim();
	if (stripped === "/dev/null") throw new Error("unified patch does not support /dev/null files");
	return stripped;
}

function parsePatch(patch: string): PatchFile[] {
	const lines = patch.replaceAll("\r\n", "\n").split("\n");
	const files: PatchFile[] = [];
	let index = 0;
	while (index < lines.length) {
		if (!lines[index]?.startsWith("--- ")) {
			index++;
			continue;
		}
		const oldPath = patchPath(lines[index]!.slice(4).split("\t", 1)[0]!);
		index++;
		if (!lines[index]?.startsWith("+++ ")) throw new Error("unified patch is missing its new-file header");
		const newPath = patchPath(lines[index]!.slice(4).split("\t", 1)[0]!);
		if (oldPath !== newPath) throw new Error("unified patch rename/delete headers are not supported");
		index++;
		const hunks: PatchHunk[] = [];
		while (index < lines.length && lines[index]?.startsWith("@@ ")) {
			const header = lines[index]!;
			const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(header);
			if (!match) throw new Error(`invalid unified hunk header: ${header}`);
			const oldStart = Number(match[1]);
			const oldCount = Number(match[2] ?? "1");
			const newStart = Number(match[3]);
			const newCount = Number(match[4] ?? "1");
			index++;
			const oldLines: string[] = [];
			const newLines: string[] = [];
			while (index < lines.length && !lines[index]!.startsWith("@@ ") && !lines[index]!.startsWith("--- ")) {
				const line = lines[index]!;
				index++;
				if (line === "\\ No newline at end of file") continue;
				const marker = line[0];
				if (marker === " " || marker === "-") oldLines.push(line.slice(1));
				if (marker === " " || marker === "+") newLines.push(line.slice(1));
				if (marker !== " " && marker !== "-" && marker !== "+") throw new Error("invalid unified patch line");
			}
			if (oldLines.length !== oldCount || newLines.length !== newCount) throw new Error("unified patch hunk line count mismatch");
			hunks.push({ oldStart, oldCount, oldLines, newLines });
		}
		if (hunks.length === 0) throw new Error("unified patch has no hunks");
		files.push({ path: newPath, hunks });
	}
	if (files.length === 0) throw new Error("unified patch has no file sections");
	return files;
}

export async function applyUnifiedPatchAdapter(workspaceRoot: string, patch: string): Promise<NativeToolResult> {
	const files = parsePatch(patch);
	const changed: string[] = [];
	for (const file of files) {
		const path = workspacePath(workspaceRoot, file.path);
		const original = (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
		const source = original.split("\n");
		let shift = 0;
		for (const hunk of file.hunks) {
			const start = hunk.oldStart - 1 + shift;
			if (start < 0 || start + hunk.oldLines.length > source.length) throw new Error(`unified patch hunk is outside ${file.path}`);
			for (let line = 0; line < hunk.oldLines.length; line++) {
				if (source[start + line] !== hunk.oldLines[line]) throw new Error(`unified patch context mismatch in ${file.path}`);
			}
			source.splice(start, hunk.oldLines.length, ...hunk.newLines);
			shift += hunk.newLines.length - hunk.oldLines.length;
		}
		await writeFile(path, source.join("\n"), "utf8");
		changed.push(file.path);
	}
	return result(`Patched ${changed.join(", ")}`, { files: changed });
}

export async function assertWorkspacePath(workspaceRoot: string, requested: string): Promise<string> {
	const path = workspacePath(workspaceRoot, requested);
	await stat(path);
	return path;
}
