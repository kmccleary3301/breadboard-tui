import { type CanonicalJson, isJsonRecord as isRecord, type JsonRecord } from "../canonical-json";
import { parseHarnessYaml } from "../compiler";
import { loadEngineDataSnapshot } from "../engine-data";
import { nativeLockValue } from "./lock-values";
import type { NativeToolDefinition, NativeToolSurfacePack } from "./types";

const TOOL_DEFINITION_PREFIX = "implementations/tools/defs/";
const BASE_REGISTRY_PATH = "implementations/tools/defs";
const RESEARCH_DEFINITION_PATH = /^(?:implementations\/tools\/defs_(?:cc|oc|omo)|defs_(?:pi|oh_my_pi))\/.+\.ya?ml$/u;
/** Keys `tool_yaml_loader._to_enhanced_params` strips before treating a parameter as its schema. */
const NON_SCHEMA_PARAMETER_KEYS = new Set(["name", "description", "required", "default", "examples", "validation"]);

function requiredString(value: CanonicalJson | undefined, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`tool definition ${label} must be a non-empty string`);
	return value;
}
const TYPE_MAP: Readonly<Record<string, string>> = {
	int: "integer",
	integer: "integer",
	float: "number",
	number: "number",
	bool: "boolean",
	boolean: "boolean",
	str: "string",
	string: "string",
	array: "array",
	object: "object",
};

function schemaType(value: CanonicalJson | undefined): string {
	return typeof value === "string" ? (TYPE_MAP[value] ?? value) : "string";
}

/** Mirror pyref `provider/adapters.py:88-169,236-308` for one YAML parameter. */
function parameterSchema(parameter: JsonRecord, label: string, provider: "anthropic" | "openai"): JsonRecord {
	const explicit = parameter.schema;
	const hasExplicitSchema = isRecord(explicit) && Object.keys(explicit).length > 0;
	const hasSchemaShape = hasExplicitSchema || Object.keys(parameter).some(key => !NON_SCHEMA_PARAMETER_KEYS.has(key));
	const schema: Record<string, CanonicalJson> = {};
	if (hasExplicitSchema) {
		Object.assign(schema, explicit);
	} else {
		for (const [key, value] of Object.entries(parameter)) {
			if (!NON_SCHEMA_PARAMETER_KEYS.has(key)) schema[key] = value;
		}
	}
	if (Object.keys(schema).length === 0) schema.type = schemaType(parameter.type);
	else if (!("type" in schema) && !("anyOf" in schema) && !("oneOf" in schema) && !("allOf" in schema)) schema.type = schemaType(parameter.type);
	const description = parameter.description;
	if (typeof description === "string" && description.length > 0 && !("description" in schema)) schema.description = description;
	if (schema.type === "array" && !("items" in schema)) schema.items = { type: "string" };
	if (schema.type === "object") {
		if (provider === "openai" || !hasSchemaShape) schema.properties ??= {};
		if (!("additionalProperties" in schema)) schema.additionalProperties = true;
	}
	const fallback = parameter.default;
	if (fallback !== undefined && fallback !== null && !("default" in schema)) schema.default = fallback;
	if (typeof schema.type !== "string" && !("anyOf" in schema) && !("oneOf" in schema) && !("allOf" in schema)) throw new Error(`tool definition ${label}.type must be a string`);
	return provider === "anthropic" ? Object.fromEntries(Object.entries(schema).sort(([left], [right]) => left.localeCompare(right))) : schema;
}

function providerForSource(path: string): "anthropic" | "openai" {
	return path.startsWith("implementations/tools/defs_cc/") ? "anthropic" : "openai";
}

function parseToolDefinition(source: JsonRecord, path: string): NativeToolDefinition {
	const provider = providerForSource(path);
	const isGroupB = path.startsWith("defs_pi/") || path.startsWith("defs_oh_my_pi/");
	const name = requiredString(source.name, `${path} name`);
	const rawParameters = source.parameters ?? [];
	if (!Array.isArray(rawParameters)) throw new Error(`tool definition ${name}.parameters must be a list`);
	const properties: Record<string, CanonicalJson> = {};
	const required: string[] = [];
	for (const [index, rawParameter] of rawParameters.entries()) {
		if (!isRecord(rawParameter)) throw new Error(`tool definition ${name}.parameters[${index}] must be a mapping`);
		const parameterName = rawParameter.name;
		if (typeof parameterName !== "string" || parameterName.length === 0) continue;
		properties[parameterName] = parameterSchema(rawParameter, `${name}.${parameterName}`, provider);
		if (rawParameter.required === true) required.push(parameterName);
	}
	const orderedProperties = isGroupB ? Object.fromEntries(Object.entries(properties).sort(([left], [right]) => left.localeCompare(right))) : properties;
	const routing = isRecord(source.provider_routing) ? source.provider_routing[provider] : undefined;
	const routingRecord = isRecord(routing) ? routing : {};
	const parameters: Record<string, CanonicalJson> = { type: "object", properties: orderedProperties };
	if (provider === "openai" || required.length > 0) parameters.required = required;
	const additionalProps = routingRecord.additional_properties ?? routingRecord.additionalProperties;
	if (typeof additionalProps === "boolean") parameters.additionalProperties = additionalProps;
	if (provider === "anthropic") {
		const schemaUri = routingRecord.schema_uri ?? routingRecord.$schema;
		if (typeof schemaUri === "string" && schemaUri.length > 0) parameters.$schema = schemaUri;
	}
	const execution = isRecord(source.execution) ? source.execution : {};
	const maxPerTurn = execution.max_per_turn;
	const strict = routingRecord.strict;
	return Object.freeze({
		id: requiredString(source.id, `${name}.id`),
		sourcePath: path,
		name,
		description: typeof source.description === "string" ? source.description : "",
		parameters: Object.freeze(parameters),
		...(provider === "openai" && typeof strict === "boolean" ? { strict } : {}),
		nativePrimary: routingRecord.native_primary === true,
		...(typeof maxPerTurn === "number" && Number.isInteger(maxPerTurn) && maxPerTurn > 0 ? { maxPerTurn } : {}),
	});
}


function definitionSourcePath(definition: NativeToolDefinition): string {
	return definition.sourcePath ?? definition.name;
}

function compareSourcePath(left: NativeToolDefinition, right: NativeToolDefinition): number {
	return definitionSourcePath(left) < definitionSourcePath(right) ? -1 : definitionSourcePath(left) > definitionSourcePath(right) ? 1 : 0;
}
type DefinitionCatalog = ReadonlyMap<string, readonly NativeToolDefinition[]>;

async function vendoredToolDefinitions(): Promise<DefinitionCatalog> {
	const snapshot = await loadEngineDataSnapshot();
	const byRegistry = new Map<string, NativeToolDefinition[]>();
	for (const file of snapshot.files) {
		if ((!file.path.startsWith(TOOL_DEFINITION_PREFIX) && !RESEARCH_DEFINITION_PATH.test(file.path)) || !/\.ya?ml$/u.test(file.path)) continue;
		const slash = file.path.lastIndexOf("/");
		const registryPath = slash < 0 ? file.path : file.path.slice(0, slash);
		const definitions = byRegistry.get(registryPath) ?? [];
		definitions.push(parseToolDefinition(parseHarnessYaml(file.content), file.path));
		byRegistry.set(registryPath, definitions);
	}
	for (const definitions of byRegistry.values()) definitions.sort(compareSourcePath);
	return byRegistry;
}

function registryPaths(lock: JsonRecord): readonly string[] {
	const paths = nativeLockValue(lock, "tools.registry.paths");
	return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string") : [];
}
function registryInclude(lock: JsonRecord): readonly string[] {
	const include = nativeLockValue(lock, "tools.registry.include");
	return Array.isArray(include) ? include.filter((name): name is string => typeof name === "string") : [];
}

function registryValue(lock: JsonRecord, path: string): CanonicalJson | undefined {
	return nativeLockValue(lock, path);
}

function registryDefinitions(lock: JsonRecord, catalog: DefinitionCatalog): Array<[string, NativeToolDefinition]> {
	const base = catalog.get(BASE_REGISTRY_PATH) ?? [];
	const definitions = new Map(base.map(definition => [definition.name, definition] as [string, NativeToolDefinition]));
	const order = base.map(definition => definition.name);
	for (const path of registryPaths(lock)) {
		const pathDefinitions = catalog.get(path) ?? [];
		for (const definition of pathDefinitions) {
			if (!definitions.has(definition.name)) order.push(definition.name);
			definitions.set(definition.name, definition);
		}
	}
	return order.flatMap(name => {
		const definition = definitions.get(name);
		return definition === undefined ? [] : [[name, definition] as [string, NativeToolDefinition]];
	});
}

function definitionsForLock(lock: JsonRecord, catalog: DefinitionCatalog): ReadonlyMap<string, NativeToolDefinition> {
	let entries = registryDefinitions(lock, catalog);
	const legacyEnabled = registryValue(lock, "tools.enabled");
	const exclude = registryValue(lock, "tools.registry.exclude");
	const excludeSet = new Set(Array.isArray(exclude) ? exclude.filter((name): name is string => typeof name === "string") : []);
	entries = entries.filter(([name]) => !excludeSet.has(name));

	const include = registryInclude(lock);
	const wildcard = include.some(name => name === "*" || name === "*.*" || name === "all");
	if (include.length > 0 && !wildcard) {
		const included = new Set(include);
		const byName = new Map(entries);
		entries = include.flatMap(name => {
			const definition = byName.get(name);
			return definition === undefined ? [] : [[name, definition] as [string, NativeToolDefinition]];
		});
		entries.push(...[...byName.entries()].filter(([name]) => !included.has(name)));
	} else if (include.length === 0 && isRecord(legacyEnabled)) {
		entries = entries.filter(([name]) => legacyEnabled[name] === true);
	}

	const claudeRegistry = registryPaths(lock).some(path => path.endsWith("/defs_cc"));
	const todosEnabled = registryValue(lock, "features.todos.enabled");
	if (claudeRegistry && todosEnabled !== true) {
		// Anthropic runtime drops TodoWrite when features.todos.enabled is false
		// (`provider/runtimes/anthropic.py:714-753`); Claude's canonical lock sets it
		// false (`agent_configs/claude_code_2-1-63_e4_3-6-2026.yaml:288-292`).
		entries = entries.map(([name, definition]) =>
			name === "TodoWrite" ? [name, { ...definition, nativePrimary: false }] : [name, definition],
		);
	}
	const multiAgent = registryValue(lock, "multi_agent.enabled");
	const taskTool = registryValue(lock, "task_tool");
	if (multiAgent !== undefined || taskTool !== undefined) {
		const taskEnabled = multiAgent === true || (isRecord(taskTool) ? Object.keys(taskTool).length > 0 : taskTool === true);
		if (!taskEnabled) entries = entries.filter(([name]) => name !== "task" && name !== "Task");
	}

	const rlmEnabled = registryValue(lock, "features.rlm.enabled");
	if (rlmEnabled !== undefined && rlmEnabled !== true) {
		const rlmNames = new Set(["blob.put", "blob.put_file_slice", "blob.get", "blob.search", "llm.query", "llm.batch_query"]);
		entries = entries.filter(([name]) => !rlmNames.has(name));
	}
	return new Map(entries);
}
async function vendoredToolDefinitionsForLock(lock: JsonRecord): Promise<ReadonlyMap<string, NativeToolDefinition>> {
	return definitionsForLock(lock, await vendoredToolDefinitions());
}
function modeRecords(lock: JsonRecord): readonly JsonRecord[] {
	const modes = nativeLockValue(lock, "modes");
	return Array.isArray(modes) ? modes.filter(isRecord) : [];
}

function selectedToolNames(
	mode: JsonRecord,
	definitions: ReadonlyMap<string, NativeToolDefinition>,
	preserveExplicitOrder: boolean,
): readonly string[] {
	const enabled = Array.isArray(mode.tools_enabled) ? mode.tools_enabled.filter((name): name is string => typeof name === "string") : [];
	const disabled = new Set(
		Array.isArray(mode.tools_disabled) ? mode.tools_disabled.filter((name): name is string => typeof name === "string") : [],
	);
	const enabledSet = new Set(enabled);
	const selected =
		enabled.length === 0 || enabledSet.has("*")
			? [...definitions.keys()]
			: preserveExplicitOrder
				? enabled.filter(name => definitions.has(name))
				: [...definitions.keys()].filter(name => enabledSet.has(name));
	const filtered = selected.filter(name => !disabled.has(name));
	// Python falls back to the complete `tool_defs` input when exclusions remove every tool
	// (`agent_llm_openai.py:3093-3111`).
	return filtered.length === 0 ? [...definitions.keys()] : filtered;
}

async function loadNativeToolSurfacesWithDefinitions(
	lock: JsonRecord,
	definitions: ReadonlyMap<string, NativeToolDefinition>,
): Promise<ReadonlyMap<string, NativeToolSurfacePack>> {
	const surfaces = new Map<string, NativeToolSurfacePack>();
	const preserveExplicitOrder = registryPaths(lock).some(path => RESEARCH_DEFINITION_PATH.test(`${path}/placeholder.yaml`));
	for (const mode of modeRecords(lock)) {
		const modeName = requiredString(mode.name, "modes[].name");
		const enabled = selectedToolNames(mode, definitions, preserveExplicitOrder).map(name => {
			const definition = definitions.get(name);
			if (definition === undefined) throw new Error(`native harness tool ${name} has no vendored definition`);
			return definition;
		});
		surfaces.set(
			modeName,
			Object.freeze({
				mode: modeName,
				native: Object.freeze(enabled.filter(tool => tool.nativePrimary)),
				textInvoked: Object.freeze(enabled.filter(tool => !tool.nativePrimary)),
			}),
		);
	}
	return surfaces;
}


/**
 * Build the locked mode tool surfaces from vendored definitions. Disabled names are removed after
 * inclusion, matching `agent_llm_openai.py:3093-3111`.
 */
export async function loadNativeToolSurfaces(lock: JsonRecord): Promise<ReadonlyMap<string, NativeToolSurfacePack>> {
	return loadNativeToolSurfacesWithDefinitions(lock, await vendoredToolDefinitionsForLock(lock));
}

/** Build the first declared mode surface for single-stage callers. */
export async function loadNativeToolSurface(lock: JsonRecord): Promise<NativeToolSurfacePack> {
	const surfaces = await loadNativeToolSurfaces(lock);
	const first = surfaces.values().next().value;
	if (first === undefined) throw new Error("native harness lock has no modes");
	return first;
}

/** Provider function-tool payload for one native tool, as the Python reference serializes it. */
export function nativeFunctionTool(tool: NativeToolDefinition): JsonRecord {
	const fn: Record<string, CanonicalJson> = { name: tool.name, description: tool.description, parameters: tool.parameters };
	if (tool.strict !== undefined) fn.strict = tool.strict;
	return { type: "function", function: fn };
}


/** Load every snapshotted research registry from its source YAML. */
export async function loadNativeToolDefinitionsByRegistryPath(): Promise<DefinitionCatalog> {
	return vendoredToolDefinitions();
}