import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const root = resolve(process.argv[process.argv.indexOf("--root") + 1] ?? "../../../../breadboard-native-harness-artifacts/14-research-packs-g4/final-sweep10");
const packs = ["claude_code", "codex", "opencode", "oh_my_opencode", "pi", "oh_my_pi"] as const;
const controls = ["description", "tools-swapped", "type-deleted", "strict-deleted", "message-extra", "message-content"] as const;

function stable(value: Json): Json {
	if (Array.isArray(value)) return value.map(stable);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([key, item]) => [key, stable(item)]));
	}
	return value;
}

function hash(value: Json): string {
	return new Bun.CryptoHasher("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

async function load(path: string): Promise<Json> {
	return JSON.parse(await readFile(path, "utf8")) as Json;
}

for (const pack of packs) {
	const oracleEnvelope = await load(join(root, "transformed", `${pack}.python.transformed.json`)) as { normalized: Json };
	const nativeEnvelope = await load(join(root, "normalized", `${pack}.native.normalized.json`)) as { normalized: Json };
	const oracle = oracleEnvelope.normalized;
	const native = nativeEnvelope.normalized;
	const oracleBytes = JSON.stringify(stable(oracle));
	const nativeBytes = JSON.stringify(stable(native));
	console.log(`PARITY ${pack} equal=${oracleBytes === nativeBytes} oracle_sha256=${hash(oracle)} native_sha256=${hash(native)}`);
	for (const control of controls) {
		const candidate = await load(join(root, "controls-normalized", `${pack}.${control}.normalized.json`)) as { normalized: Json };
		console.log(`CONTROL ${pack} kind=${control} unequal=${JSON.stringify(stable(candidate.normalized)) !== oracleBytes} native_sha256=${hash(candidate.normalized)}`);
	}
}
