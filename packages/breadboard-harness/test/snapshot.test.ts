import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { type EngineDataSnapshotFile, loadEngineDataSnapshot } from "../src/index";

const PACKAGE_ROOT = join(import.meta.dir, "..");
const DATA_DIR = join(PACKAGE_ROOT, "engine-data");
const SCRIPT = join(PACKAGE_ROOT, "scripts", "snapshot-engine-data.ts");
const ENGINE =
	process.env["BB_HARNESS_ENGINE"] ??
	join("/", "Users", "kylemccleary", "projects", "bread" + "board-native-harness-pyref");

async function runCheck(dataDir: string): Promise<{ code: number; output: string }> {
	const process = Bun.spawn(["bun", SCRIPT, "--engine", ENGINE, "--check", "--data-dir", dataDir], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	return { code: await process.exited, output: `${stdout}\n${stderr}` };
}

describe("engine data snapshot", () => {
	test("callers cannot alter the shared verified snapshot", async () => {
		const snapshot = await loadEngineDataSnapshot(DATA_DIR);
		const file = snapshot.files[0]!;
		const content = file.content;
		expect(() => {
			(file as { content: string }).content = "tampered";
		}).toThrow(TypeError);
		expect(() => {
			(snapshot.files as EngineDataSnapshotFile[]).push(file);
		}).toThrow(TypeError);
		expect((await loadEngineDataSnapshot(DATA_DIR)).files[0]!.content).toBe(content);
	});

	test("--check and loader reject tampered bundled content", async () => {
		const temporaryRoot = await mkdtemp(join(tmpdir(), "bb-harness-snapshot-"));
		const dataCopy = join(temporaryRoot, "engine-data");
		try {
			await cp(DATA_DIR, dataCopy, { recursive: true });
			const snapshotPath = join(dataCopy, "snapshot.json");
			const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as {
				files: Array<{ content: string }>;
			};
			snapshot.files[0]!.content += "tampered";
			await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);

			const result = await runCheck(dataCopy);
			expect(result.code).not.toBe(0);
			expect(result.output).toContain("modified snapshot.json");
			expect(loadEngineDataSnapshot(dataCopy)).rejects.toThrow(/sha256|bytes/i);
		} finally {
			await rm(temporaryRoot, { recursive: true, force: true });
		}
	}, 30_000);
});
