import { describe, expect, test } from "bun:test";

import { canonicalJson, JsonFloat } from "../../src/canonical-json";
import {
	compileHarnessDefinition,
	compileHarnessYaml,
	HarnessCompileError,
	parseHarnessYaml,
	validateHarnessDefinition,
} from "../../src/compiler";

const MINIMAL_V3 = `schema_version: bb.harness_definition.v1
version: 1
workspace:
  root: .
providers:
  default_model: mock/reference
  models:
    - id: mock/reference
      adapter: mock_chat
modes:
  - name: respond
loop:
  sequence:
    - mode: respond
`;

const MINIMAL_GRAPH_HASH = "sha256:44d8f8419c75ed272f4d0ee6e881da9c02b104a94cdb37f47cb0718b0e491d2e";

describe("harness compiler", () => {
	test("matches Python graph hashes for representative canonical fixtures", () => {
		const minimal = compileHarnessYaml(MINIMAL_V3, { sourceRef: "agent_configs/templates/minimal_harness.v3.yaml" });
		expect(minimal.lock.graph_hash).toBe(MINIMAL_GRAPH_HASH);
	});

	test("keeps YAML 1.1 booleans, octal, sexagesimal and float identity", () => {
		const parsed = parseHarnessYaml(
			"yes_value: yes\noctal_value: 012\ntime_value: 1:20\nfloat_value: 1.0\nexponent_value: 1e3\n",
		);
		expect(parsed.yes_value).toBe(true);
		expect(parsed.octal_value).toBe(10);
		expect(parsed.time_value).toBe(80);
		expect(canonicalJson(parsed)).toContain('"float_value": 1.0');
		expect(canonicalJson(parsed)).toContain('"exponent_value": 1000.0');
	});

	test("applies default, base and overlay precedence with source provenance", () => {
		const result = compileHarnessDefinition(
			{ extends: "base", nested: { root: true }, value: "root" },
			{
				sourceRef: "root.yaml",
				defaults: { nested: { default: true }, value: "default" },
				loadRef: (_parent, ref) => ({ resolvedRef: ref, definition: { nested: { base: true }, value: "base" } }),
				overlays: [{ nested: { overlay: true }, value: "overlay" }],
			},
		);
		expect(result.effective).toEqual({
			nested: { base: true, default: true, overlay: true, root: true },
			value: "overlay",
		});
		expect(result.lock.source_layers).toEqual([
			expect.objectContaining({ layer_id: "harness-default:0000", precedence: 0 }),
			expect.objectContaining({ layer_id: "agent-config:0000:base", precedence: 10 }),
			expect.objectContaining({ layer_id: "agent-config:0001:root.yaml", precedence: 20 }),
			expect.objectContaining({ layer_id: "harness-overlay:0000", precedence: 30 }),
		]);
	});

	test("rejects an incomplete canonical definition before producing a lock", () => {
		expect(() =>
			compileHarnessDefinition(
				{ schema_version: "bb.harness_definition.v1", version: 1 },
				{ sourceRef: "invalid.yaml" },
			),
		).toThrow(
			"invalid Harness Definition: /loop [required]; /modes [required]; /providers [required]; /workspace [required]",
		);
	});

	test("reports all nested type findings in deterministic pointer order", () => {
		try {
			compileHarnessDefinition(
				{
					schema_version: "bb.harness_definition.v1",
					version: 1,
					workspace: null,
					providers: null,
					modes: null,
					loop: null,
				},
				{ sourceRef: "invalid.yaml" },
			);
			throw new Error("expected validation to reject");
		} catch (error) {
			expect(error).toMatchObject({
				code: "definition_invalid",
				stage: "validation",
				findings: [
					{ pointer: "/loop", code: "type" },
					{ pointer: "/modes", code: "type" },
					{ pointer: "/providers", code: "type" },
					{ pointer: "/workspace", code: "type" },
				],
			});
		}
	});

	test("reports escaped unknown keys and oneOf branch failures", () => {
		try {
			compileHarnessDefinition(
				{
					schema_version: "bb.harness_definition.v1",
					version: 1,
					workspace: { root: ".", "a/b~c": true },
					providers: { default_model: "main", models: [{ id: "main", adapter: "openai" }] },
					modes: [{ name: "build" }],
					loop: { sequence: [{ mode: "build" }] },
					features: { plan: [] },
				},
				{ sourceRef: "invalid.yaml" },
			);
			throw new Error("expected validation to reject");
		} catch (error) {
			expect(error).toMatchObject({
				findings: [
					{ pointer: "/features/plan", code: "oneOf" },
					{ pointer: "/workspace/a~1b~0c", code: "additionalProperties" },
				],
			});
		}
	});
	test("rejects YAML float discriminators as unsupported versions", () => {
		expect(() =>
			compileHarnessYaml(MINIMAL_V3.replace("version: 1", "version: 1.0"), { sourceRef: "invalid.yaml" }),
		).toThrow("invalid Harness Definition: /version [unsupported_version]");
	});

	test("resolves nested local references in external schema definitions", () => {
		expect(
			validateHarnessDefinition({
				schema_version: "bb.harness_definition.v1",
				version: 1,
				workspace: { root: "." },
				providers: { default_model: "main", models: [{ id: "main", adapter: "openai" }] },
				modes: [{ name: "build" }],
				loop: { sequence: [{ mode: "build" }] },
				multi_agent: { team_config: { team: { agents: { a: { role: "builder" } } } } },
			}),
		).toEqual([]);
	});

	test("treats inherited object names as additional properties", () => {
		const findings = validateHarnessDefinition({
			schema_version: "bb.harness_definition.v1",
			version: 1,
			workspace: { root: ".", toString: true },
			providers: { default_model: "main", models: [{ id: "main", adapter: "openai" }] },
			modes: [{ name: "build" }],
			loop: { sequence: [{ mode: "build" }] },
		});
		expect(findings.map(finding => [finding.pointer, finding.code])).toEqual([
			["/workspace/toString", "additionalProperties"],
		]);
	});
	test("accepts integral YAML floats for integer schema properties", () => {
		const findings = validateHarnessDefinition({
			schema_version: "bb.harness_definition.v1",
			version: 1,
			workspace: { root: "." },
			providers: {
				default_model: "main",
				models: [{ id: "main", adapter: "openai", params: { max_output_tokens: new JsonFloat(1) } }],
			},
			modes: [{ name: "build" }],
			loop: { sequence: [{ mode: "build" }] },
		});
		expect(findings).toEqual([]);
	});
	test("reports numeric minimum alongside integer type for a negative YAML float", () => {
		const findings = validateHarnessDefinition({
			schema_version: "bb.harness_definition.v1",
			version: 1,
			workspace: { root: "." },
			providers: { default_model: "main", models: [{ id: "main", adapter: "openai" }] },
			modes: [{ name: "build" }],
			loop: { plan_turn_limit: new JsonFloat(-0.5), sequence: [{ mode: "build" }] },
		});
		expect(findings.map(finding => [finding.pointer, finding.code])).toEqual([
			["/loop/plan_turn_limit", "minimum"],
			["/loop/plan_turn_limit", "type"],
		]);
	});

	test("reports one cycle back-edge finding", () => {
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		const findings = validateHarnessDefinition({
			schema_version: "bb.harness_definition.v1",
			version: 1,
			workspace: { root: "." },
			providers: { default_model: "main", models: [{ id: "main", adapter: "openai" }] },
			modes: [{ name: "build" }],
			loop: { sequence: [{ mode: "build" }] },
			dossier: { bad: cycle },
		});
		expect(findings.map(finding => [finding.pointer, finding.code])).toEqual([["/dossier/bad/self", "json_cycle"]]);
	});
});
