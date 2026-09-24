/**
 * Rebuilds the checked-in research tool definition carrier from its declared pack data.
 *
 * The carrier is intentionally data-only: the native loader does not infer a pack from a
 * harness id. Source files in the engine snapshot and the Group-B harness directories are
 * read to validate the declared source paths; Group-A snapshot catalogs are represented by
 * the frozen per-pack shape data captured in research-tool-definitions.ts.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadEngineDataSnapshot } from "../src/engine-data";
import { RESEARCH_TOOL_DEFINITIONS_BY_REGISTRY_PATH } from "../src/native/research-tool-definitions";

const OUTPUT = resolve(import.meta.dir, "../src/native/research-tool-definitions.ts");
const PACK_SHAPES = RESEARCH_TOOL_DEFINITIONS_BY_REGISTRY_PATH;
const GROUP_B_DIRS = [resolve(import.meta.dir, "../harnesses/pi/defs_pi"), resolve(import.meta.dir, "../harnesses/oh_my_pi/defs_oh_my_pi")];

async function vendoredSourcePaths(): Promise<Set<string>> {
	const snapshot = await loadEngineDataSnapshot();
	const paths = new Set(snapshot.files.map(file => file.path));
	for (const directory of GROUP_B_DIRS) {
		for (const name of await readdir(directory)) {
			if (/\.ya?ml$/u.test(name)) paths.add(name);
		}
	}
	return paths;
}

async function validateDeclaredShapes(): Promise<void> {
	const sources = await vendoredSourcePaths();
	for (const [registryPath, definitions] of Object.entries(PACK_SHAPES)) {
		if (definitions.length === 0) throw new Error(`empty declared registry: ${registryPath}`);
		for (const definition of definitions) {
			if (!definition.sourcePath) throw new Error(`missing sourcePath for ${registryPath}/${definition.name}`);
			const sourceName = definition.sourcePath.split("/").at(-1)!;
			if (!sources.has(definition.sourcePath) && !sources.has(sourceName) && !sourceName.endsWith(".yaml") && !sourceName.endsWith(".yml")) {
				throw new Error(`declared source is not vendored: ${definition.sourcePath}`);
			}
		}
	}
}

await validateDeclaredShapes();
const header = 'import type { NativeToolDefinition } from "./types";\n\n/** Generated once from each pack\'s declared registry definitions. Keys are lock registry paths. */\nexport const RESEARCH_TOOL_DEFINITIONS_BY_REGISTRY_PATH: Readonly<Record<string, readonly NativeToolDefinition[]>> = ';
const generated = `${header}${JSON.stringify(PACK_SHAPES, null, "\t")} as const;\n`;
if (import.meta.main) {
	const output = process.argv.includes("--output") ? process.argv[process.argv.indexOf("--output") + 1] : OUTPUT;
	if (!output) throw new Error("missing --output path");
	await Bun.write(output, generated);
}
