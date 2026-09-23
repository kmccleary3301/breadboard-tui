// Module imports, not runtime paths: `bun build --compile` embeds the harness sources in the binary.
import bbOmpNativeSpec from "../../harnesses/bb-omp.native/bb-omp.harness.yaml" with { type: "text" };
import bbOmpNativeIdentity from "../../harnesses/bb-omp.native/prompts/identity.md" with { type: "text" };

/** A harness shipped with the product. Its checked-in lock beside the spec is kept equal by tests. */
export interface BuiltinNativeHarness {
	readonly id: string;
	/** `source_ref` the lock records: the spec path under the package's `harnesses/` directory. */
	readonly sourceRef: string;
	readonly source: string;
	/** Prompt resources by the name the spec uses. */
	readonly resources: ReadonlyMap<string, string>;
}

/** The daily-driver harness: OMP's own tools, prompt and model, plus the BreadBoard identity pack. */
export const DEFAULT_NATIVE_HARNESS_ID = "bb-omp.native";

const BUILTIN_NATIVE_HARNESSES: ReadonlyMap<string, BuiltinNativeHarness> = new Map([
	[
		DEFAULT_NATIVE_HARNESS_ID,
		Object.freeze({
			id: DEFAULT_NATIVE_HARNESS_ID,
			sourceRef: "bb-omp.native/bb-omp.harness.yaml",
			source: bbOmpNativeSpec,
			resources: new Map([["prompts/identity.md", bbOmpNativeIdentity]]),
		}),
	],
]);

export function builtinNativeHarness(id: string): BuiltinNativeHarness | undefined {
	return BUILTIN_NATIVE_HARNESSES.get(id);
}

export function builtinNativeHarnesses(): readonly BuiltinNativeHarness[] {
	return [...BUILTIN_NATIVE_HARNESSES.values()];
}
