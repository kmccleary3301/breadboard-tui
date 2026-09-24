import { type CanonicalJson, isJsonRecord as isRecord, type JsonRecord } from "../canonical-json";
import { parseHarnessYaml } from "../compiler";
import { loadEngineDataSnapshot } from "../engine-data";
import { nativeLockValue } from "./lock-values";
import { RESEARCH_TOOL_DEFINITIONS_BY_REGISTRY_PATH } from "./research-tool-definitions";
import type { NativeToolDefinition, NativeToolSurfacePack } from "./types";

const TOOL_DEFINITION_PREFIX = "implementations/tools/defs/";
/**
 * The product engine reaches models through the TUI gateway, and the Python reference routes every
 * gateway request through its OpenAI adapter (`provider/adapters.py:362-375`), so R39 tool routing
 * always reads `provider_routing.openai`.
 */
const GATEWAY_ROUTING_PROVIDER = "openai";
/** Keys `tool_yaml_loader._to_enhanced_params` strips before treating a parameter as its schema. */
const NON_SCHEMA_PARAMETER_KEYS = new Set(["name", "description", "required", "default", "examples", "validation"]);

function requiredString(value: CanonicalJson | undefined, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`tool definition ${label} must be a non-empty string`);
	return value;
}

/** Mirror `OpenAIAdapter.translate_tool_to_native_schema` for one YAML parameter. */
function parameterSchema(parameter: JsonRecord, label: string): JsonRecord {
	const explicit = parameter.schema;
	const schema: Record<string, CanonicalJson> = {};
	if (isRecord(explicit)) {
		Object.assign(schema, explicit);
	} else {
		for (const [key, value] of Object.entries(parameter)) {
			if (!NON_SCHEMA_PARAMETER_KEYS.has(key)) schema[key] = value;
		}
	}
	if (Object.keys(schema).length === 0) {
		// Python's minimal-schema fallback.
		schema.type = parameter.type ?? "string";
	} else if (!("type" in schema)) {
		schema.type = parameter.type ?? "string";
	}
	const description = parameter.description;
	if (typeof description === "string" && description.length > 0 && !("description" in schema)) {
		schema.description = description;
	}
	if (schema.type === "array" && !("items" in schema)) schema.items = { type: "string" };
	if (schema.type === "object") {
		if (!("properties" in schema)) schema.properties = {};
		if (!("additionalProperties" in schema)) schema.additionalProperties = true;
	}
	const fallback = parameter.default;
	if (fallback !== undefined && fallback !== null && !("default" in schema)) schema.default = fallback;
	if (typeof schema.type !== "string") throw new Error(`tool definition ${label}.type must be a string`);
	return schema;
}

function parseToolDefinition(source: JsonRecord, path: string): NativeToolDefinition {
	const name = requiredString(source.name, `${path} name`);
	const rawParameters = source.parameters ?? [];
	if (!Array.isArray(rawParameters)) throw new Error(`tool definition ${name}.parameters must be a list`);
	const properties: Record<string, CanonicalJson> = {};
	const required: string[] = [];
	for (const [index, rawParameter] of rawParameters.entries()) {
		if (!isRecord(rawParameter)) throw new Error(`tool definition ${name}.parameters[${index}] must be a mapping`);
		const parameterName = rawParameter.name;
		// Python skips unnamed parameters.
		if (typeof parameterName !== "string" || parameterName.length === 0) continue;
		properties[parameterName] = parameterSchema(rawParameter, `${name}.${parameterName}`);
		if (rawParameter.required === true) required.push(parameterName);
	}
	const routing = isRecord(source.provider_routing) ? source.provider_routing[GATEWAY_ROUTING_PROVIDER] : undefined;
	const routingRecord = isRecord(routing) ? routing : {};
	const parameters: Record<string, CanonicalJson> = { type: "object", properties, required };
	if (typeof routingRecord.additional_properties === "boolean") {
		parameters.additionalProperties = routingRecord.additional_properties;
	}
	const execution = isRecord(source.execution) ? source.execution : {};
	const maxPerTurn = execution.max_per_turn;
	return Object.freeze({
		id: requiredString(source.id, `${name}.id`),
		name,
		description: typeof source.description === "string" ? source.description : "",
		parameters: Object.freeze(parameters),
		...(typeof routingRecord.strict === "boolean" ? { strict: routingRecord.strict } : {}),
		nativePrimary: routingRecord.native_primary === true,
		...(typeof maxPerTurn === "number" && Number.isInteger(maxPerTurn) && maxPerTurn > 0 ? { maxPerTurn } : {}),
	});
}

async function vendoredToolDefinitions(): Promise<ReadonlyMap<string, NativeToolDefinition>> {
	const snapshot = await loadEngineDataSnapshot();
	const definitions: NativeToolDefinition[] = [];
	for (const file of snapshot.files) {
		if (!file.path.startsWith(TOOL_DEFINITION_PREFIX) || !/\.ya?ml$/u.test(file.path)) continue;
		definitions.push(parseToolDefinition(parseHarnessYaml(file.content), file.path));
	}
	definitions.sort((left, right) => left.name.localeCompare(right.name));
	return new Map(definitions.map(definition => [definition.name, definition]));
}

function registryPaths(lock: JsonRecord): readonly string[] {
	const paths = nativeLockValue(lock, "tools.registry.paths");
	return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string") : [];
}

function definitionsForLock(lock: JsonRecord, base: ReadonlyMap<string, NativeToolDefinition>): ReadonlyMap<string, NativeToolDefinition> {
	const definitions = new Map(base);
	for (const path of registryPaths(lock)) {
		for (const definition of RESEARCH_TOOL_DEFINITIONS_BY_REGISTRY_PATH[path] ?? []) definitions.set(definition.name, definition);
	}
	return new Map([...definitions.entries()].sort(([, left], [, right]) => left.name.localeCompare(right.name)));
}

async function vendoredToolDefinitionsForLock(lock: JsonRecord): Promise<ReadonlyMap<string, NativeToolDefinition>> {
	return definitionsForLock(lock, await vendoredToolDefinitions());
}

function modeRecords(lock: JsonRecord): readonly JsonRecord[] {
	const modes = nativeLockValue(lock, "modes");
	return Array.isArray(modes) ? modes.filter(isRecord) : [];
}

function selectedToolNames(mode: JsonRecord, definitions: ReadonlyMap<string, NativeToolDefinition>): readonly string[] {
	const enabled = Array.isArray(mode.tools_enabled) ? mode.tools_enabled.filter((name): name is string => typeof name === "string") : [];
	const disabled = new Set(
		Array.isArray(mode.tools_disabled) ? mode.tools_disabled.filter((name): name is string => typeof name === "string") : [],
	);
	const enabledSet = new Set(enabled);
	const selected = enabled.length === 0 || enabledSet.has("*") ? [...definitions.keys()] : [...definitions.keys()].filter(name => enabledSet.has(name));
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
	for (const mode of modeRecords(lock)) {
		const modeName = requiredString(mode.name, "modes[].name");
		const enabled = selectedToolNames(mode, definitions).map(name => {
			const definition = definitions.get(name);
			if (definition === undefined) throw new Error(`native harness tool ${name} has no vendored definition`);
			return definition;
		});
		const ordered = enabled;
		surfaces.set(
			modeName,
			Object.freeze({
				mode: modeName,
				native: Object.freeze(ordered.filter(tool => tool.nativePrimary)),
				textInvoked: Object.freeze(ordered.filter(tool => !tool.nativePrimary)),
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
