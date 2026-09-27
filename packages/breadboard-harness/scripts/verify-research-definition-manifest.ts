#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type Entry = { readonly path: string; readonly sha256: string; readonly bytes: number };
type Manifest = { readonly pyrefCommit: string; readonly pyrefTree: string; readonly files: readonly Entry[] };

function arg(name: string, fallback: string): string {
	const index = Bun.argv.indexOf(name);
	return index >= 0 && Bun.argv[index + 1] !== undefined ? Bun.argv[index + 1]! : fallback;
}
function hash(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
function gitShow(pyref: string, commit: string, path: string): Uint8Array {
	const result = Bun.spawnSync(["git", "--no-optional-locks", "-C", pyref, "show", `${commit}:${path}`], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0)
		throw new Error(`unable to read pyref ${path}: ${new TextDecoder().decode(result.stderr).trim()}`);
	return result.stdout;
}

const root = resolve(import.meta.dir, "..");
const pyref = resolve(arg("--pyref", "/Users/kylemccleary/projects/breadboard-native-harness-pyref"));
const manifestPath = resolve(arg("--manifest", resolve(root, "engine-data/research-definitions.manifest.json")));
const snapshot = JSON.parse(await readFile(resolve(root, "engine-data/snapshot.json"), "utf8")) as {
	readonly files: readonly { readonly path: string; readonly content: string }[];
};
const snapshotByPath = new Map(snapshot.files.map(file => [file.path, file.content]));
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
let checked = 0;
for (const entry of manifest.files) {
	const bytes = entry.path.startsWith("implementations/tools/")
		? gitShow(pyref, manifest.pyrefCommit, entry.path)
		: new TextEncoder().encode(
				snapshotByPath.get(entry.path) ??
					(() => {
						throw new Error(`missing local snapshot path ${entry.path}`);
					})(),
			);
	if (bytes.byteLength !== entry.bytes || hash(bytes) !== entry.sha256)
		throw new Error(`manifest mismatch: ${entry.path}`);
	checked++;
}
console.log(`verified ${checked} research YAML manifest entries against pyref ${manifest.pyrefCommit}`);
