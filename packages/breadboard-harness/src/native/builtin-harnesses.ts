// Module imports, not runtime paths: `bun build --compile` embeds the harness sources in the binary.
import bbOmpNativeSpec from "../../harnesses/bb-omp.native/bb-omp.harness.yaml" with { type: "text" };
import bbOmpNativeIdentity from "../../harnesses/bb-omp.native/prompts/identity.md" with { type: "text" };
import claudeCodeSpec from "../../harnesses/claude_code/research.harness.yaml" with { type: "text" };
import claudeCodePrompt from "../../harnesses/claude_code/prompts/system.md" with { type: "text" };
import codexSpec from "../../harnesses/codex/research.harness.yaml" with { type: "text" };
import codexPrompt from "../../harnesses/codex/prompts/system.md" with { type: "text" };
import opencodeSpec from "../../harnesses/opencode/research.harness.yaml" with { type: "text" };
import opencodeSystem from "../../harnesses/opencode/prompts/system.md" with { type: "text" };
import opencodePlan from "../../harnesses/opencode/prompts/plan.md" with { type: "text" };
import opencodeBuilder from "../../harnesses/opencode/prompts/builder.md" with { type: "text" };
import ohMyOpencodeSpec from "../../harnesses/oh_my_opencode/research.harness.yaml" with { type: "text" };
import ohMyOpencodeSystem from "../../harnesses/oh_my_opencode/prompts/system.md" with { type: "text" };
import ohMyOpencodeBuilder from "../../harnesses/oh_my_opencode/prompts/builder.md" with { type: "text" };
import piSpec from "../../harnesses/pi/research.harness.yaml" with { type: "text" };
import piPrompt from "../../harnesses/pi/prompts/system.md" with { type: "text" };
import ohMyPiSpec from "../../harnesses/oh_my_pi/research.harness.yaml" with { type: "text" };
import ohMyPiPrompt from "../../harnesses/oh_my_pi/prompts/system.md" with { type: "text" };

export interface BuiltinNativeHarness {
	readonly id: string;
	readonly sourceRef: string;
	readonly source: string;
	readonly resources: ReadonlyMap<string, string>;
}

export const DEFAULT_NATIVE_HARNESS_ID = "bb-omp.native";

const BUILTIN_NATIVE_HARNESSES: ReadonlyMap<string, BuiltinNativeHarness> = new Map([
	[
		DEFAULT_NATIVE_HARNESS_ID,
		{
			id: DEFAULT_NATIVE_HARNESS_ID,
			sourceRef: "bb-omp.native/bb-omp.harness.yaml",
			source: bbOmpNativeSpec,
			resources: new Map([["prompts/identity.md", bbOmpNativeIdentity]]),
		},
	],
	[
		"claude_code",
		{
			id: "claude_code",
			sourceRef: "claude_code/research.harness.yaml",
			source: claudeCodeSpec,
			resources: new Map([["prompts/system.md", claudeCodePrompt]]),
		},
	],
	[
		"codex",
		{
			id: "codex",
			sourceRef: "codex/research.harness.yaml",
			source: codexSpec,
			resources: new Map([["prompts/system.md", codexPrompt]]),
		},
	],
	[
		"opencode",
		{
			id: "opencode",
			sourceRef: "opencode/research.harness.yaml",
			source: opencodeSpec,
			resources: new Map([
				["prompts/system.md", opencodeSystem],
				["prompts/plan.md", opencodePlan],
				["prompts/builder.md", opencodeBuilder],
			]),
		},
	],
	[
		"oh_my_opencode",
		{
			id: "oh_my_opencode",
			sourceRef: "oh_my_opencode/research.harness.yaml",
			source: ohMyOpencodeSpec,
			resources: new Map([
				["prompts/system.md", ohMyOpencodeSystem],
				["prompts/builder.md", ohMyOpencodeBuilder],
			]),
		},
	],
	[
		"pi",
		{
			id: "pi",
			sourceRef: "pi/research.harness.yaml",
			source: piSpec,
			resources: new Map([["prompts/system.md", piPrompt]]),
		},
	],
	[
		"oh_my_pi",
		{
			id: "oh_my_pi",
			sourceRef: "oh_my_pi/research.harness.yaml",
			source: ohMyPiSpec,
			resources: new Map([["prompts/system.md", ohMyPiPrompt]]),
		},
	],
]);

export function builtinNativeHarness(id: string): BuiltinNativeHarness | undefined {
	return BUILTIN_NATIVE_HARNESSES.get(id);
}

export function builtinNativeHarnesses(): readonly BuiltinNativeHarness[] {
	return [...BUILTIN_NATIVE_HARNESSES.values()];
}
