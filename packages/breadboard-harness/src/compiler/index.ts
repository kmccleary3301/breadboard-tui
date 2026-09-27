import YAML, {
	type Alias,
	type Document,
	type Node,
	type Pair,
	type Scalar,
	type YAMLMap,
	type YAMLSeq,
	isAlias,
	isMap,
	isScalar,
	isSeq,
} from "yaml";

import {
	JsonFloat,
	type CanonicalJson,
	canonicalJson,
	graphContentHash,
	isJsonRecord as isRecord,
	type JsonRecord,
	sha256Json,
} from "../canonical-json";
import { type HarnessValidationFinding, validateHarnessDefinition } from "./validate";

export { type HarnessValidationFinding, validateBundledSchema, validateHarnessDefinition } from "./validate";
export type HarnessDefinition = JsonRecord;
export interface HarnessCompileErrorOptions {
	readonly code?: string;
	readonly stage?: "parse" | "compile" | "validation";
	readonly findings?: readonly HarnessValidationFinding[];
}

export class HarnessCompileError extends Error {
	readonly code: string;
	readonly stage: "parse" | "compile" | "validation";
	readonly findings: readonly HarnessValidationFinding[];

	constructor(message: string, options: HarnessCompileErrorOptions = {}) {
		super(message);
		this.name = "HarnessCompileError";
		this.code = options.code ?? "compile_error";
		this.stage = options.stage ?? "compile";
		this.findings = Object.freeze(options.findings === undefined ? [] : [...options.findings]);
	}
}

export class HarnessReferenceMissingError extends HarnessCompileError {
	constructor(message: string) {
		super(message, { code: "reference_missing" });
		this.name = "HarnessReferenceMissingError";
	}
}

export type HarnessLoadReference = (
	parentSourceRef: string,
	declaredReference: string,
) => { readonly resolvedRef: string; readonly definition: JsonRecord };

export interface HarnessCompileOptions {
	readonly sourceRef: string;
	readonly loadRef?: HarnessLoadReference;
	readonly defaults?: JsonRecord;
	readonly overlays?: readonly JsonRecord[];
	readonly resourceInputs?: ReadonlyMap<string, Uint8Array> | Readonly<Record<string, Uint8Array>>;
}

export interface HarnessCompilation {
	readonly lock: JsonRecord;
	readonly effective: JsonRecord;
	readonly resolvedAuthor: JsonRecord;
}

interface SourceLayer {
	readonly [key: string]: CanonicalJson;
	readonly host_visible: true;
	readonly layer_hash: string;
	readonly layer_id: string;
	readonly model_visible: true;
	precedence: number;
	readonly scope: string;
	readonly source_kind: string;
	readonly source_ref: string | null;
}

interface LeafSource {
	readonly kind: "leaf";
	readonly layerId: string;
	readonly metadata: JsonRecord;
}

interface MapSource {
	readonly kind: "map";
	readonly children: Record<string, Provenance>;
}

type Provenance = LeafSource | MapSource;

interface MergedValue {
	readonly value: CanonicalJson;
	readonly source: Provenance;
}

const EMPTY_RECORD = (): JsonRecord => ({});

function compareCodePoints(left: string, right: string): number {
	const a = [...left];
	const b = [...right];
	const length = Math.min(a.length, b.length);
	for (let index = 0; index < length; index += 1) {
		const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
		if (difference !== 0) return difference;
	}
	return a.length - b.length;
}

function sortedKeys(record: JsonRecord): string[] {
	return Object.keys(record).sort(compareCodePoints);
}

function clone(value: CanonicalJson): CanonicalJson {
	if (value instanceof JsonFloat) return new JsonFloat(value.value);
	if (Array.isArray(value)) return value.map(clone);
	if (isRecord(value)) {
		const result: JsonRecord = {};
		for (const key of Object.keys(value)) result[key] = clone(value[key]!);
		return result;
	}
	return value;
}

function asRecord(value: CanonicalJson, label: string): JsonRecord {
	if (!isRecord(value)) throw new HarnessCompileError(`${label} must be a mapping`, { code: "compile_error" });
	return clone(value) as JsonRecord;
}

function asDocument(value: unknown, label: string): JsonRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value) || value instanceof JsonFloat) {
		throw new HarnessCompileError(`${label} must be a mapping`, { code: "definition_invalid" });
	}
	return value as JsonRecord;
}

function metadataLeaf(value: CanonicalJson): value is JsonRecord {
	return isRecord(value) && "value" in value && ("env_name" in value || "env_satisfied" in value);
}

function makeLeaf(layerId: string, metadata: JsonRecord = EMPTY_RECORD()): LeafSource {
	return { kind: "leaf", layerId, metadata };
}

function merge(
	current: CanonicalJson | undefined,
	sources: Provenance | undefined,
	incoming: CanonicalJson,
	layerId: string,
	metadataEnabled = true,
): MergedValue {
	if (metadataEnabled && metadataLeaf(incoming)) {
		const metadata: JsonRecord = {};
		for (const key of Object.keys(incoming)) if (key !== "value") metadata[key] = clone(incoming[key]!);
		const envName = metadata.env_name;
		if (envName !== undefined && (typeof envName !== "string" || envName.length === 0)) {
			throw new HarnessCompileError("env_name metadata must be a non-empty string", { code: "metadata_invalid" });
		}
		const envSatisfied = metadata.env_satisfied;
		if (envSatisfied !== undefined && typeof envSatisfied !== "boolean") {
			throw new HarnessCompileError("env_satisfied metadata must be a boolean", { code: "metadata_invalid" });
		}
		return { value: clone(incoming.value!), source: makeLeaf(layerId, metadata) };
	}
	if (isRecord(incoming)) {
		if (Object.keys(incoming).length === 0 && (!isRecord(current) || Object.keys(current).length === 0)) {
			return { value: {}, source: makeLeaf(layerId) };
		}
		const values: JsonRecord = isRecord(current) ? (clone(current) as JsonRecord) : {};
		const children: Record<string, Provenance> = sources?.kind === "map" ? { ...sources.children } : {};
		for (const key of sortedKeys(incoming)) {
			const prior = merge(values[key], children[key], incoming[key]!, layerId, metadataEnabled);
			values[key] = prior.value;
			children[key] = prior.source;
		}
		return { value: values, source: { kind: "map", children } };
	}
	return { value: clone(incoming), source: makeLeaf(layerId) };
}

function runtimeValues(document: JsonRecord): JsonRecord {
	const values: JsonRecord = {};
	for (const key of Object.keys(document))
		if (key !== "extends" && key !== "dossier") values[key] = clone(document[key]!);
	return values;
}

function references(document: JsonRecord, sourceRef: string): readonly string[] {
	const declared = document.extends;
	if (declared === undefined) return [];
	const values = Array.isArray(declared) ? declared : [declared];
	const refs: string[] = [];
	for (const value of values) {
		if (typeof value !== "string" || value.trim().length === 0) {
			throw new HarnessCompileError(`invalid reference declared by ${sourceRef}`, { code: "reference_invalid" });
		}
		refs.push(value);
	}
	return refs;
}

function sourceBasename(reference: string): string {
	const normalized = reference.replaceAll("\\", "/");
	return normalized.slice(normalized.lastIndexOf("/") + 1) || "source";
}

function sourceStem(reference: string): string {
	const basename = sourceBasename(reference);
	const dot = basename.lastIndexOf(".");
	return dot > 0 ? basename.slice(0, dot) : basename;
}

function flatten(
	values: CanonicalJson,
	sources: Provenance,
	prefix = "",
): readonly [string, CanonicalJson, string, JsonRecord][] {
	if (sources.kind === "leaf")
		return [[prefix, clone(values), sources.layerId, clone(sources.metadata) as JsonRecord]];
	const rows: [string, CanonicalJson, string, JsonRecord][] = [];
	if (isRecord(values)) {
		for (const key of sortedKeys(values)) {
			const child = sources.children[key];
			if (child === undefined) continue;
			const path = prefix ? `${prefix}.${key}` : key;
			rows.push(...flatten(values[key]!, child, path));
		}
	}
	return rows;
}

function sourceRows(sources: Provenance, prefix = ""): [string, string][] {
	if (sources.kind === "leaf") return [[prefix, sources.layerId]];
	const rows: [string, string][] = [];
	for (const key of Object.keys(sources.children).sort(compareCodePoints)) {
		const path = prefix ? `${prefix}.${key}` : key;
		rows.push(...sourceRows(sources.children[key]!, path));
	}
	return rows;
}

function valueKind(value: CanonicalJson): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return "boolean";
	if (typeof value === "number" || value instanceof JsonFloat) return "number";
	if (typeof value === "string") return "string";
	if (Array.isArray(value)) return "array";
	return "object";
}

function looksSecret(path: string): boolean {
	return path
		.toLowerCase()
		.split(".")
		.map(part => part.replaceAll("-", "_"))
		.some(
			part =>
				part === "api_key" ||
				part === "apikey" ||
				part === "password" ||
				part === "secret" ||
				part === "token" ||
				part.includes("api_key") ||
				part.includes("apikey") ||
				part.endsWith("_password") ||
				part.endsWith("_secret") ||
				part.endsWith("_token"),
		);
}

function sha256Bytes(bytes: Uint8Array): string {
	return `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`;
}

function resourceEntries(inputs: HarnessCompileOptions["resourceInputs"], startPrecedence: number): SourceLayer[] {
	if (inputs === undefined) return [];
	const entries: [string, Uint8Array][] = inputs instanceof Map ? [...inputs.entries()] : Object.entries(inputs);
	entries.sort(([left], [right]) => compareCodePoints(left, right));
	return entries.map(([sourceRef], index) => {
		const content =
			inputs instanceof Map ? inputs.get(sourceRef)! : (inputs as Readonly<Record<string, Uint8Array>>)[sourceRef]!;
		if (typeof sourceRef !== "string" || sourceRef.trim().length === 0) {
			throw new HarnessCompileError("resource reference must be a non-empty string", { code: "resource_invalid" });
		}
		if (!(content instanceof Uint8Array)) {
			throw new HarnessCompileError(`resource '${sourceRef}' content must be bytes`, { code: "resource_invalid" });
		}
		return {
			host_visible: true,
			layer_hash: sha256Bytes(content),
			layer_id: `harness-resource:${String(index).padStart(4, "0")}`,
			model_visible: true,
			precedence: startPrecedence + index * 10,
			scope: "resource",
			source_kind: "project",
			source_ref: sourceRef,
		};
	});
}

function validateDefinition(document: JsonRecord): void {
	const findings = validateHarnessDefinition(document);
	if (findings.length === 0) return;
	const detail = findings.map(finding => `${finding.pointer} [${finding.code}]`).join("; ");
	throw new HarnessCompileError(`invalid Harness Definition: ${detail}`, {
		code: "definition_invalid",
		stage: "validation",
		findings,
	});
}

function fieldStrings(value: CanonicalJson): string[] {
	if (typeof value === "string") return value ? [value] : [];
	if (Array.isArray(value)) return value.flatMap(fieldStrings);
	if (isRecord(value)) return sortedKeys(value).flatMap(key => fieldStrings(value[key]!));
	return [];
}

function summary(values: JsonRecord, extendsChain: readonly string[]): JsonRecord {
	const providers = values.providers;
	const modes = values.modes;
	const prompts = values.prompts;
	const modeRows = Array.isArray(modes) ? modes : [];
	const tools = new Set<string>();
	for (const mode of modeRows) {
		if (!isRecord(mode)) continue;
		const enabled = mode.tools_enabled;
		if (Array.isArray(enabled)) for (const tool of enabled) if (typeof tool === "string") tools.add(tool);
	}
	const defaultModel =
		isRecord(providers) && typeof providers.default_model === "string" ? providers.default_model : "";
	const modeIds = modeRows
		.filter((mode): mode is JsonRecord => isRecord(mode) && "name" in mode)
		.map(mode => String(mode.name))
		.sort(compareCodePoints);
	const packs = isRecord(prompts) ? prompts.packs : undefined;
	return {
		provider_default_model: defaultModel,
		mode_ids: modeIds,
		tool_count: tools.size,
		prompt_files: [...new Set(fieldStrings(packs ?? null))].sort(compareCodePoints),
		extends_chain: [...extendsChain],
	};
}

function effect(path: string, severity: string, message: string, source: string, blocker = false): JsonRecord {
	return {
		severity,
		class: "other",
		path,
		message: `${blocker ? "blocker" : "effect"}=${message}; source=${source}`,
	};
}

function override(path: string, source: string, winner: string): JsonRecord {
	return {
		severity: "info",
		class: "other",
		path,
		message: `effect=overridden; source=${source}; winner=${winner}`,
	};
}

function compileDocument(definition: JsonRecord, options: HarnessCompileOptions): HarnessCompilation {
	if (options.sourceRef.trim().length === 0)
		throw new HarnessCompileError("source_ref must be a non-empty string", { code: "source_invalid" });
	const root = asRecord(definition, "definition");
	const sourceHashes = new Map<string, string>([[options.sourceRef, sha256Json(root)]]);
	const layers: { readonly record: SourceLayer; readonly values: JsonRecord; readonly authored: JsonRecord | null }[] =
		[];
	const extendsChain: string[] = [];
	let sourceNumber = 0;
	const addSource = (document: JsonRecord, ref: string): void => {
		const values = runtimeValues(document);
		layers.push({
			record: {
				host_visible: true,
				layer_hash: sha256Json(values),
				layer_id: `agent-config:${String(sourceNumber).padStart(4, "0")}:${sourceBasename(ref)}`,
				model_visible: true,
				precedence: 0,
				scope: "agent",
				source_kind: "project",
				source_ref: ref,
			},
			values,
			authored: Object.fromEntries(Object.entries(document).filter(([key]) => key !== "extends")),
		});
		sourceNumber += 1;
	};
	const visit = (document: JsonRecord, ref: string, stack: readonly string[]): void => {
		for (const declared of references(document, ref)) {
			if (options.loadRef === undefined)
				throw new HarnessCompileError(`no loader for reference '${declared}' from '${ref}'`, {
					code: "reference_loader_missing",
				});
			let loaded: { readonly resolvedRef: string; readonly definition: JsonRecord };
			try {
				loaded = options.loadRef(ref, declared);
			} catch (error) {
				if (error instanceof HarnessReferenceMissingError) throw error;
				throw new HarnessReferenceMissingError(`missing reference '${declared}' from '${ref}'`);
			}
			if (loaded.resolvedRef.trim().length === 0)
				throw new HarnessCompileError("loader returned an invalid resolved reference", {
					code: "reference_invalid",
				});
			const child = asRecord(loaded.definition, `reference '${loaded.resolvedRef}'`);
			const digest = sha256Json(child);
			const prior = sourceHashes.get(loaded.resolvedRef);
			if (prior !== undefined && prior !== digest)
				throw new HarnessCompileError(`inconsistent content for resolved reference '${loaded.resolvedRef}'`, {
					code: "reference_inconsistent",
				});
			sourceHashes.set(loaded.resolvedRef, digest);
			if (stack.includes(loaded.resolvedRef))
				throw new HarnessCompileError(`cyclic reference: ${[...stack, loaded.resolvedRef].join(" -> ")}`, {
					code: "reference_cycle",
				});
			extendsChain.push(loaded.resolvedRef);
			visit(child, loaded.resolvedRef, [...stack, loaded.resolvedRef]);
		}
		addSource(document, ref);
	};
	if (options.defaults !== undefined) {
		const defaults = runtimeValues(asRecord(options.defaults, "defaults"));
		layers.push({
			record: {
				host_visible: true,
				layer_hash: sha256Json(defaults),
				layer_id: "harness-default:0000",
				model_visible: true,
				precedence: 0,
				scope: "agent",
				source_kind: "default",
				source_ref: null,
			},
			values: defaults,
			authored: null,
		});
	}
	visit(root, options.sourceRef, [options.sourceRef]);
	for (const [index, overlay] of (options.overlays ?? []).entries()) {
		const values = runtimeValues(asRecord(overlay, `overlay ${index}`));
		layers.push({
			record: {
				host_visible: true,
				layer_hash: sha256Json(values),
				layer_id: `harness-overlay:${String(index).padStart(4, "0")}`,
				model_visible: true,
				precedence: 0,
				scope: "agent",
				source_kind: "runtime",
				source_ref: `overlay:${index}`,
			},
			values,
			authored: null,
		});
	}

	let effective: CanonicalJson = {};
	let provenance: Provenance = { kind: "map", children: {} };
	let author: CanonicalJson = {};
	let authorSources: Provenance = { kind: "map", children: {} };
	const diagnostics: JsonRecord[] = [];
	const sourceLayers: SourceLayer[] = [];
	for (const [index, layer] of layers.entries()) {
		layer.record.precedence = index * 10;
		sourceLayers.push(layer.record);
		if (layer.authored !== null) {
			const mergedAuthor = merge(author, authorSources, layer.authored, layer.record.layer_id, false);
			author = mergedAuthor.value;
			authorSources = mergedAuthor.source;
		}
		const before = new Map(sourceRows(provenance));
		const merged = merge(effective, provenance, layer.values, layer.record.layer_id);
		effective = merged.value;
		provenance = merged.source;
		const after = new Map(sourceRows(provenance));
		if (layer.record.source_kind === "default") {
			for (const [path, source] of after)
				if (source === layer.record.layer_id)
					diagnostics.push(effect(path, "info", "defaulted", layer.record.layer_id));
		}
		for (const [path, source] of before)
			if (after.get(path) !== source) diagnostics.push(override(path, source, layer.record.layer_id));
	}
	sourceLayers.push(...resourceEntries(options.resourceInputs, sourceLayers.length * 10));
	const effectiveRecord = asRecord(effective, "effective configuration");
	const authorRecord = asRecord(author, "resolved author");
	if (authorRecord.schema_version === "bb.harness_definition.v1") {
		try {
			validateDefinition(authorRecord);
		} catch (error) {
			if (error instanceof HarnessCompileError) {
				throw new HarnessCompileError(
					`invalid Harness Definition: ${error.message.replace(/^invalid Harness Definition: /, "")}`,
					{
						code: "definition_invalid",
						stage: "validation",
						findings: error.findings,
					},
				);
			}
			throw error;
		}
	}
	const rows = flatten(effective, provenance);
	if (rows.length === 0 || rows.some(([path]) => path.length === 0))
		throw new HarnessCompileError("effective configuration must contain at least one value", {
			code: "effective_empty",
		});
	const envGates = new Map<string, JsonRecord>();
	const effectiveValues: JsonRecord[] = [];
	for (const [path, value, source, metadata] of rows) {
		const envName = metadata.env_name;
		const redacted = (typeof envName === "string" && envName.length > 0) || looksSecret(path);
		const gateIds = typeof envName === "string" && envName.length > 0 ? [`env.${envName}`] : [];
		if (typeof envName === "string" && envName.length > 0) {
			envGates.set(gateIds[0]!, {
				env_name: envName,
				gate_id: gateIds[0]!,
				required: true,
				satisfied: metadata.env_satisfied === true,
			});
		}
		const redactedValue: CanonicalJson = redacted
			? typeof envName === "string" && envName.length > 0
				? `secret://env/${envName}`
				: `secret://redacted/${path.replaceAll(".", "/")}`
			: clone(value);
		effectiveValues.push({
			env_gate_ids: gateIds,
			path,
			source_layer_id: source,
			value: redactedValue,
			value_kind: redacted ? "secret-ref" : valueKind(value),
			visibility: redacted ? "redacted" : "model-visible",
		});
	}
	for (const [path, value, source] of rows) {
		diagnostics.push(effect(path, "info", "selected", source));
		if (
			path === "capabilities" ||
			path.startsWith("capabilities.") ||
			path.includes(".capabilities.") ||
			path.endsWith(".capabilities")
		) {
			diagnostics.push(
				effect(path, "info", value === true ? "capability_enabled" : "capability_configured", source),
			);
			if (value === false) diagnostics.push(effect(path, "warning", "capability_disabled", source, true));
		}
	}
	const redactedPaths = effectiveValues.filter(row => row.visibility === "redacted").map(row => String(row.path));
	const graph: JsonRecord = {
		effective_values: effectiveValues,
		env_gates: [...envGates.keys()].sort(compareCodePoints).map(key => envGates.get(key)!),
		graph_hash: null,
		graph_id: `agent_config:${sourceStem(options.sourceRef)}`,
		merge_policy: {
			conflict_resolution: "highest-precedence",
			policy_id: "precedence_order_deep_merge",
			strategy: "deep-merge",
		},
		migrations: [
			{
				applied: true,
				from_version: "agent-config-yaml",
				migration_id: "agent-config-yaml-to-effective-config-graph-v1",
				to_version: "bb.effective_config_graph.v1",
			},
		],
		schema_version: "bb.effective_config_graph.v1",
		source_layers: sourceLayers,
		visibility: {
			host_only_paths: [],
			model_visible_paths: effectiveValues
				.filter(row => row.visibility === "model-visible")
				.map(row => String(row.path)),
			redacted_paths: redactedPaths,
		},
	};
	graph.graph_hash = graphContentHash(graph);
	const surface =
		effectiveRecord.schema_version === "bb.agent_config_surface.v2" ||
		effectiveRecord.schema_version === "bb.agent_config_surface.v1"
			? effectiveRecord.schema_version
			: "bb.agent_config_surface.v1";
	const explanation: JsonRecord = {
		schema_version: "bb.config_explanation.v1",
		explanation_id: `harness_explanation:${sha256Json(options.sourceRef).slice(7, 23)}`,
		config_path: options.sourceRef,
		config_sha256: sha256Json(authorRecord),
		generated_at_utc: "1970-01-01T00:00:00Z",
		surface_schema_version: surface,
		resolved_summary: summary(effectiveRecord, extendsChain),
		fields: rows.map(([path, _value, source]) => ({
			classification: "operational",
			consumer_ref: null,
			path,
			source_layer: source,
		})),
		diagnostics: diagnostics.sort((left, right) =>
			compareCodePoints(String(left.path) + String(left.message), String(right.path) + String(right.message)),
		),
		ok: true,
	};
	return { lock: graph, effective: effectiveRecord, resolvedAuthor: authorRecord };
}

/** Parse YAML with PyYAML-compatible YAML 1.1 scalar resolution and retain float identity. */
export function parseHarnessYaml(source: string): JsonRecord {
	let document: Document<Node>;
	try {
		document = YAML.parseDocument(source, { version: "1.1", merge: true, uniqueKeys: false });
	} catch (error) {
		throw new HarnessCompileError(error instanceof Error ? error.message : String(error), {
			code: "yaml_parse_error",
			stage: "parse",
		});
	}
	if (document.errors.length > 0) {
		throw new HarnessCompileError(document.errors.map(error => error.message).join("; "), {
			code: "yaml_parse_error",
			stage: "parse",
		});
	}
	const active = new Set<Node>();
	const convert = (node: Node | null | undefined): CanonicalJson => {
		if (node === null || node === undefined) return null;
		if (isAlias(node)) {
			if (active.has(node))
				throw new HarnessCompileError("YAML aliases must not contain cycles", {
					code: "yaml_cycle",
					stage: "parse",
				});
			return convert((node as Alias).resolve(document));
		}
		if (isScalar(node)) {
			const scalar = node as Scalar<unknown>;
			if (typeof scalar.value === "number") {
				if (scalar.source === ".") return ".";
				if (!Number.isFinite(scalar.value))
					throw new HarnessCompileError("JSON numbers must be finite", { code: "finite", stage: "parse" });
				return /[.eE]/.test(scalar.source ?? "") ? new JsonFloat(scalar.value) : scalar.value;
			}
			if (scalar.value === null || typeof scalar.value === "boolean" || typeof scalar.value === "string")
				return scalar.value;
			throw new HarnessCompileError("YAML scalar is outside the JSON domain", { code: "json_type", stage: "parse" });
		}
		if (isSeq(node)) {
			const sequence = node as YAMLSeq;
			active.add(node);
			const result = sequence.items.map(item => convert(item as Node));
			active.delete(node);
			return result;
		}
		if (isMap(node)) {
			const map = node as YAMLMap;
			active.add(node);
			const result: JsonRecord = {};
			const merged: JsonRecord[] = [];
			for (const pair of map.items as Pair<Node, Node>[]) {
				const key = convert(pair.key);
				if (key === "<<") {
					const value = convert(pair.value);
					if (Array.isArray(value))
						for (const item of value)
							if (isRecord(item)) merged.push(item);
							else if (isRecord(value)) merged.push(value);
					continue;
				}
				if (typeof key !== "string")
					throw new HarnessCompileError("Object keys must be strings", { code: "json_key", stage: "parse" });
				result[key] = convert(pair.value);
			}
			for (const inherited of merged.reverse())
				for (const [key, value] of Object.entries(inherited)) if (!(key in result)) result[key] = clone(value);
			active.delete(node);
			return result;
		}
		throw new HarnessCompileError("YAML node is outside the JSON domain", { code: "json_type", stage: "parse" });
	};
	return asDocument(convert(document.contents), "YAML document");
}

/** Compile a parsed `bb.harness_definition.v1`/legacy agent config to an effective graph. */
export function compileHarnessDefinition(
	definition: HarnessDefinition,
	options: HarnessCompileOptions,
): HarnessCompilation {
	return compileDocument(definition, options);
}

/** Parse and compile one YAML harness definition without a Python runtime. */
export function compileHarnessYaml(source: string, options: HarnessCompileOptions): HarnessCompilation {
	return compileHarnessDefinition(parseHarnessYaml(source), options);
}

export function canonicalLockJson(compilation: HarnessCompilation): string {
	return canonicalJson(compilation.lock);
}
