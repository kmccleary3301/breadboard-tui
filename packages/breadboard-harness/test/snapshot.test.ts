import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { loadEngineDataManifest } from "../src/index";

const PACKAGE_ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(PACKAGE_ROOT, "engine-data");
const SCRIPT = join(PACKAGE_ROOT, "scripts", "snapshot-engine-data.ts");
const ENGINE =
	process.env["BB_HARNESS_ENGINE"] ??
	join("/", "Users", "kylemccleary", "projects", "bread" + "board-native-harness-pyref");

function hash(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function runCheck(dataDir: string): Promise<{ code: number; output: string }> {
	const process = Bun.spawn(
		["bun", SCRIPT, "--engine", ENGINE, "--check", "--data-dir", dataDir],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text()]);
	return { code: await process.exited, output: `${stdout}\n${stderr}` };
}

describe("engine data snapshot", () => {
	test("manifest hashes match every vendored file", async () => {
		const manifest = await loadEngineDataManifest(DATA_DIR);
		const seen = new Set<string>();
		for (const entry of manifest.files) {
			seen.add(entry.path);
			const bytes = await readFile(join(DATA_DIR, ...entry.path.split("/")));
			expect(bytes.byteLength).toBe(entry.bytes);
			expect(hash(bytes)).toBe(entry.sha256);
		}
		const onDisk: string[] = [];
		for await (const path of new Bun.Glob("**/*").scan({ cwd: DATA_DIR, onlyFiles: true, dot: true })) {
			if (path !== "snapshot.manifest.json") onDisk.push(path);
		}
		expect(onDisk.sort()).toEqual([...seen].sort());
		expect(seen.size).toBe(manifest.files.length);
	});

	test("--check reports a modified snapshot in an isolated copy", async () => {
		const temporaryRoot = await mkdtemp(join(tmpdir(), "bb-harness-snapshot-"));
		const dataCopy = join(temporaryRoot, "engine-data");
		try {
			await cp(DATA_DIR, dataCopy, { recursive: true });
			const manifest = await loadEngineDataManifest(dataCopy);
			const changed = manifest.files[0];
			if (changed === undefined) throw new Error("snapshot manifest unexpectedly contains no files");
			const changedPath = join(dataCopy, ...changed.path.split("/"));
			const bytes = await readFile(changedPath);
			bytes[0] = (bytes[0] ?? 0) ^ 0xff;
			await writeFile(changedPath, bytes);

			const result = await runCheck(dataCopy);
			expect(result.code).not.toBe(0);
			expect(result.output).toContain(`modified ${changed.path}`);
		} finally {
			await rm(temporaryRoot, { recursive: true, force: true });
		}
	}, 30_000);
});
