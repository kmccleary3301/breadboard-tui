import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
	applyUnifiedPatchAdapter,
	createFileFromBlockAdapter,
	listDirAdapter,
	readFileAdapter,
} from "../../src/native/adapters";
import { isJsonRecord } from "../../src/canonical-json";
import type { NativeToolResult } from "../../src/native/types";

const FIXTURES = join(import.meta.dir, "fixtures");

type Fixture = {
	tool: string;
	input: unknown;
	initial: Record<string, string>;
	python: { text: string; details: Record<string, unknown>; isError?: boolean };
	final: Record<string, string>;
	symlinks?: Record<string, string>;
	outside?: Record<string, string>;
};

/** Fixture inputs carry `<WORKSPACE>` where the reference capture used its absolute workspace path. */
function materialize(value: unknown, root: string): unknown {
	if (typeof value === "string") return value.replaceAll("<WORKSPACE>", root);
	if (Array.isArray(value)) return value.map(item => materialize(item, root));
	if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, materialize(item, root)]));
	return value;
}

async function run(root: string, fixture: Fixture): Promise<NativeToolResult> {
	fixture = { ...fixture, input: materialize(fixture.input, root) };
	switch (fixture.tool) {
		case "read_file": return readFileAdapter(root, fixture.input as { path: string; offset?: number; limit?: number });
		case "list_dir": return listDirAdapter(root, fixture.input as { path: string; depth?: number });
		case "create_file_from_block": return createFileFromBlockAdapter(root, fixture.input as { filePath?: string; file_name?: string; content: string });
		case "apply_unified_patch": return applyUnifiedPatchAdapter(root, fixture.input as string);
		default: throw new Error(`unknown fixture tool ${fixture.tool}`);
	}
}

async function command(root: string, args: string[]): Promise<void> {
	const process = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
	await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text()]);
	expect(await process.exited).toBe(0);
}

async function files(root: string): Promise<Record<string, string>> {
	const output: Record<string, string> = {};
	async function walk(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.name === ".git" || entry.name === ".breadboard") continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile()) output[relative(root, path)] = await readFile(path, "utf8");
		}
	}
	await walk(root);
	return Object.fromEntries(Object.entries(output).sort(([left], [right]) => left.localeCompare(right)));
}

function scrub(value: unknown, root: string): unknown {
	if (typeof value === "string") return value.replaceAll(root, "<WORKSPACE>");
	if (Array.isArray(value)) return value.map(item => scrub(item, root));
	if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item, root)]));
	return value;
}

const fixturePaths = (await readdir(FIXTURES)).filter(path => path.endsWith(".json")).sort();

describe("R39 native adapters", () => {
	for (const fixturePath of fixturePaths) {
		test(fixturePath, async () => {
			const fixture = JSON.parse(await readFile(join(FIXTURES, fixturePath), "utf8")) as Fixture;
			const root = await mkdtemp(join(tmpdir(), "bb-native-adapter-"));
			const outsidePaths: string[] = [];
			let outsideRoot: string | undefined;
			try {
				for (const [path, content] of Object.entries(fixture.initial)) {
					const target = join(root, path);
					await mkdir(resolve(target, ".."), { recursive: true });
					await writeFile(target, content, "utf8");
				}
				if (Object.keys(fixture.outside ?? {}).length > 0) {
					outsideRoot = await mkdtemp(join(tmpdir(), "bb-native-adapter-outside-"));
					outsidePaths.push(outsideRoot);
					for (const [path, content] of Object.entries(fixture.outside ?? {})) {
						const target = join(outsideRoot, path);
						await mkdir(resolve(target, ".."), { recursive: true });
						await writeFile(target, content, "utf8");
					}
				}
				for (const [path, target] of Object.entries(fixture.symlinks ?? {})) {
					const resolvedTarget = target === "__OUTSIDE__" ? outsideRoot! : target === "__REENTER__" ? join(root, "public") : target;
					await symlink(resolvedTarget, join(root, path), "dir");
				}
				if (fixture.tool === "apply_unified_patch") {
					await command(root, ["init"]);
					await command(root, ["add", "-A"]);
					if (Object.keys(fixture.initial).length > 0) await command(root, ["-c", "user.name=BreadBoard", "-c", "user.email=breadboard@local", "commit", "-m", "fixture"]);
				}
				const actual = await run(root, fixture);
				const expected = { text: fixture.python.text, details: fixture.python.details, isError: Boolean(fixture.python.isError) };
				expect({ text: actual.text.replaceAll(root, "<WORKSPACE>"), details: scrub(actual.details, root), isError: Boolean(actual.isError) }).toEqual(expected);
				expect(await files(root)).toEqual(fixture.final);
			} finally {
				await rm(root, { recursive: true, force: true });
				for (const path of new Set(outsidePaths)) await rm(path, { recursive: true, force: true });
			}
		}, 30_000);
	}
});

// Deliberate divergence. For an absolute path outside the workspace, the pinned reference
// clamps the write target to the workspace root, and its local sandbox's write_text on a
// directory returns an error instead of raising. It therefore reports
// `{"ok": true, ..., "paths": [<outside path>]}` while writing nothing (capture:
// 38-apply-patch-absolute-paths/captured_outside_abs_main.json). The native adapter
// reports the failed write instead. Neither writes outside the workspace.
test("apply_unified_patch reports an outside absolute Add File as a failed write and writes nothing", async () => {
	const root = await mkdtemp(join(tmpdir(), "bb-native-adapter-outside-abs-"));
	const outsideRoot = await mkdtemp(join(tmpdir(), "bb-native-adapter-outside-target-"));
	try {
		await command(root, ["init"]);
		const outsidePath = join(outsideRoot, "outside.txt");
		const actual = await applyUnifiedPatchAdapter(root, `*** Begin Patch\n*** Add File: ${outsidePath}\n+hello outside\n*** End Patch\n`);
		expect(actual.details).toEqual({
			ok: false,
			action: "apply_patch",
			exit: 1,
			stdout: "",
			stderr: `patch did not apply: write failed in ${outsidePath}`,
			data: { manual_fallback: true, reason: `write failed in ${outsidePath}` },
		});
		expect(actual.isError).toBe(true);
		expect(await readdir(outsideRoot)).toEqual([]);
		expect(await files(root)).toEqual({});
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(outsideRoot, { recursive: true, force: true });
	}
}, 30_000);

test("read_file surfaces symlink loops as ELOOP", async () => {
	const root = await mkdtemp(join(tmpdir(), "bb-native-adapter-loop-"));
	try {
		await symlink("b", join(root, "a"), "dir");
		await symlink("a", join(root, "b"), "dir");
		const actual = await readFileAdapter(root, { path: "a/x.txt" });
		if (!isJsonRecord(actual.details) || typeof actual.details.error !== "string") throw new Error("missing ELOOP error");
		expect(actual.details.error).toContain("ELOOP: too many symbolic links encountered");
		expect(actual.isError).toBe(true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);

test("read_file refuses case variants on case-insensitive volumes", async () => {
	const root = await mkdtemp(join(tmpdir(), "bb-native-adapter-case-"));
	try {
		const actualPath = join(root, ".breadboard", "artifacts", "x.txt");
		await mkdir(resolve(actualPath, ".."), { recursive: true });
		await writeFile(actualPath, "secret\n", "utf8");
		const variantPath = join(root, ".Breadboard", "Artifacts", "x.txt");
		try {
			await readFile(variantPath, "utf8");
		} catch {
			return;
		}
		const actual = await readFileAdapter(root, { path: ".Breadboard/Artifacts/x.txt" });
		expect(actual.details).toEqual({ error: "artifact store is private; use an authorized attachment URI" });
		expect(actual.isError).toBe(true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
