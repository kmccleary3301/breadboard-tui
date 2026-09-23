import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
	applyUnifiedPatchAdapter,
	createFileFromBlockAdapter,
	listDirAdapter,
	readFileAdapter,
} from "../../packages/breadboard-harness/src/native/adapters";
import type { NativeToolResult } from "../../packages/breadboard-harness/src/native/types";

const FIXTURES = join(import.meta.dir, "fixtures");

type Fixture = {
	tool: string;
	input: unknown;
	initial: Record<string, string>;
	python: { text: string; details: Record<string, unknown>; isError?: boolean };
	final: Record<string, string>;
};

async function run(root: string, fixture: Fixture): Promise<NativeToolResult> {
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
			try {
				for (const [path, content] of Object.entries(fixture.initial)) {
					const target = join(root, path);
					await mkdir(resolve(target, ".."), { recursive: true });
					await writeFile(target, content, "utf8");
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
			}
		}, 30_000);
	}
});
