import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderBuiltinHarnessLock } from "../../scripts/builtin-harness-locks";
import { builtinNativeHarnesses, DEFAULT_NATIVE_HARNESS_ID } from "../../src/native/builtin-harnesses";
import { loadNativeHarness } from "../../src/native/load-native-harness";
import { NATIVE_BINDINGS, nativeBindingForTool, nativeToolDelegates } from "../../src/native/omp-extension";
const scratch: string[] = [];
afterEach(async () => {
	await Promise.all(scratch.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "bb-builtin-harness-test-"));
	scratch.push(root);
	return root;
}

const HOST_SPEC = `schema_version: bb.harness_definition.v1
version: 1
workspace:
  root: .
providers:
  default_model: "@host.model"
  models:
    - id: "@host.model"
      adapter: host
prompts:
  injection:
    system_order:
      - "@host.system"
      - "Appended block."
modes:
  - name: default
    tools_enabled:
      - "@host.tools"
loop:
  sequence:
    - mode: default
`;

const REGISTRY_LITERAL_EXCEPTIONS = [
	{ file: "prompt-assembly.ts", literal: "opencode", lockField: "prompts.environment.format" },
] as const;

function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
}

function withoutAllowedLockEnums(file: string, source: string): string {
	return REGISTRY_LITERAL_EXCEPTIONS.filter(exception => exception.file === file).reduce(
		(result, exception) => result.replaceAll(`"${exception.literal}"`, ""),
		source,
	);
}

const FORBIDDEN_NATIVE_IDENTIFIERS = [
	/defs_(?:cc|oc|omo|pi|oh_my_pi)/giu,
	/(?:claude_code|codex|opencode|oh_my_opencode|oh_my_pi)/giu,
	/(?<![A-Za-z0-9_$-])pi(?![A-Za-z0-9_$-])/gu,
];

describe("built-in native harnesses", () => {
	test("native runtime has no registry or harness-id dispatch literals", async () => {
		const sourceDirectory = join(import.meta.dir, "../../src/native");
		const files = (await readdir(sourceDirectory)).filter(file => file.endsWith(".ts") && file !== "builtin-harnesses.ts");
		for (const file of files) {
			const source = withoutAllowedLockEnums(file, stripComments(await readFile(join(sourceDirectory, file), "utf8")));
			for (const pattern of FORBIDDEN_NATIVE_IDENTIFIERS) {
				pattern.lastIndex = 0;
				expect(source.match(pattern), `${file} contains forbidden native dispatch literal ${pattern}`).toBeNull();
			}
		}
	});
	test("each checked-in lock and sidecar is what its spec compiles to", async () => {
		for (const harness of builtinNativeHarnesses()) {
			const expected = await renderBuiltinHarnessLock(harness);
			expect({ id: harness.id, lock: await readFile(expected.lockPath, "utf8") }).toEqual({
				id: harness.id,
				lock: expected.lockText,
			});
			expect({ id: harness.id, meta: await readFile(expected.metaPath, "utf8") }).toEqual({
				id: harness.id,
				meta: expected.metaText,
			});
		}
	});

	test("every research-pack function tool resolves to a native binding", async () => {
		for (const harness of builtinNativeHarnesses().filter(item => item.id !== DEFAULT_NATIVE_HARNESS_ID)) {
			const loaded = await loadNativeHarness({ specPath: harness.id, workspaceRoot: await workspace() });
			for (const tool of loaded.registeredToolSurface.native) {
				expect(NATIVE_BINDINGS[tool.name]).toBeDefined();
			}
		}
	});
	test("resolves declared exec bindings from every research registry", async () => {
		for (const harness of builtinNativeHarnesses().filter(item => item.id !== DEFAULT_NATIVE_HARNESS_ID)) {
			const loaded = await loadNativeHarness({ specPath: harness.id, workspaceRoot: await workspace() });
			const delegates = nativeToolDelegates(loaded);
			for (const tool of loaded.registeredToolSurface.native) {
				if (!/^(?:Bash|bash|shell_command|background_|task|webfetch|eval|interactive_bash)$/u.test(tool.name)) continue;
				expect(delegates[tool.name], `${harness.id}/${tool.name} has no runtime delegate`).toBeDefined();
			}
		}
	});
	test("uses the declared Codex shell schema when resolving its runtime binding", async () => {
		const loaded = await loadNativeHarness({ specPath: "codex", workspaceRoot: await workspace() });
		const tool = loaded.registeredToolSurface.native.find(candidate => candidate.name === "shell_command");
		if (!tool) throw new Error("missing Codex shell_command tool");
		const binding = nativeBindingForTool(tool);
		if (!binding) throw new Error("missing Codex shell_command binding");
		let received: Record<string, unknown> | undefined;
		await binding.run({
			input: { command: "cat fixture.txt", workdir: ".", timeout_ms: 5000 },
			harness: {} as never,
			context: {
				invokeTool: async (params: Record<string, unknown>) => {
					received = params;
					return { content: [{ type: "text", text: "codex-shell-ok" }] };
				},
			} as never,
			signal: undefined,
			onUpdate: undefined,
			todos: {} as never,
			guard: {} as never,
		});
		// Codex declares milliseconds; host bash takes seconds.
		expect(received).toEqual({ command: "cat fixture.txt", timeout: 5, cwd: "." });
	});

	test("bb-omp.native runs on the host surface and contributes only the identity pack", async () => {
		const harness = await loadNativeHarness({
			specPath: DEFAULT_NATIVE_HARNESS_ID,
			workspaceRoot: await workspace(),
		});
		const identity = await readFile(
			join(import.meta.dir, "../../harnesses/bb-omp.native/prompts/identity.md"),
			"utf8",
		);
		expect(harness.harnessId).toBe("bb-omp.native");
		expect(harness.hostSurface).toBe(true);
		expect(harness.systemPrompt).toBe(identity.trim());
		expect(harness.perTurnPrompt).toBe("");
		expect(harness.registeredToolSurface).toEqual({ mode: "default", native: [], textInvoked: [] });
		expect(harness.defaultModel).toBeUndefined();
		expect(harness.permissions).toEqual({ mode: undefined, shell: undefined });
	});

	test("a host-surface spec keeps a concrete default model", async () => {
		const root = await workspace();
		await writeFile(join(root, "host.yaml"), HOST_SPEC.replaceAll('"@host.model"', "openai-codex/gpt-5.6-luna"));
		const harness = await loadNativeHarness({ specPath: "host.yaml", workspaceRoot: root });
		expect(harness.hostSurface).toBe(true);
		expect(harness.systemPrompt).toBe("Appended block.");
		expect(harness.defaultModel).toBe("openai-codex/gpt-5.6-luna");
	});

	test("a partial host declaration is refused", async () => {
		const root = await workspace();
		await mkdir(join(root, "specs"));
		const cases: ReadonlyArray<readonly [string, string, RegExp]> = [
			[
				"mixed-tools",
				HOST_SPEC.replace('      - "@host.tools"\n', '      - "@host.tools"\n      - read_file\n'),
				/enables only @host\.tools/,
			],
			[
				"host-prompt-without-host-tools",
				HOST_SPEC.replace('      - "@host.tools"\n', "      - read_file\n"),
				/requires a mode with tools_enabled \[@host\.tools\]/,
			],
			[
				"host-prompt-not-first",
				HOST_SPEC.replace(
					'      - "@host.system"\n      - "Appended block."\n',
					'      - "Prepended block."\n      - "@host.system"\n',
				),
				/system_order\[1\] uses host token @host\.system outside the slot/,
			],
			[
				"no-host-prompt",
				HOST_SPEC.replace('      - "@host.system"\n', ""),
				/starts prompts\.injection\.system_order with @host\.system/,
			],
			[
				"host-token-in-pack",
				HOST_SPEC.replace("prompts:\n", 'prompts:\n  packs:\n    base:\n      system: "@host.system"\n'),
				/prompts\.packs\.base\.system uses host token @host\.system outside the slot/,
			],
			[
				"host-token-per-turn",
				HOST_SPEC.replace("  injection:\n", '  injection:\n    per_turn_order:\n      - "@host.system"\n'),
				/per_turn_order\[0\] uses host token @host\.system outside the slot/,
			],
			[
				"per-turn-block",
				HOST_SPEC.replace("  injection:\n", '  injection:\n    per_turn_order:\n      - "Turn block."\n'),
				/no per-turn prompt/,
			],
			[
				"host-tools-disabled",
				HOST_SPEC.replace(
					"modes:\n  - name: default\n",
					'modes:\n  - name: default\n    tools_disabled:\n      - "@host.tools"\n',
				),
				/tools_disabled\[0\] uses host token @host\.tools outside the slot/,
			],
			[
				"second-mode",
				HOST_SPEC.replace("modes:\n", "modes:\n  - name: extra\n    tools_enabled:\n      - read_file\n"),
				/exactly one mode/,
			],
			[
				"harness-todos",
				`${HOST_SPEC}features:\n  todos:\n    enabled: true\n`,
				/host's own todo and completion behavior/,
			],
		];
		for (const [name, source, error] of cases) {
			await writeFile(join(root, "specs", `${name}.yaml`), source);
			const outcome = await loadNativeHarness({ specPath: `specs/${name}.yaml`, workspaceRoot: root }).then(
				() => "loaded",
				(reason: unknown) => String(reason),
			);
			expect({ name, outcome }).toEqual({ name, outcome: expect.stringMatching(error) });
		}
	});
});
