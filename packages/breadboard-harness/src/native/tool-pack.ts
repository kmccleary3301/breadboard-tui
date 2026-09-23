import { type CanonicalJson, isJsonRecord as isRecord, type JsonRecord } from "../canonical-json";
import { parseHarnessYaml } from "../compiler";
import { loadEngineDataSnapshot } from "../engine-data";
import { nativeLockValue } from "./lock-values";
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
	const byName = new Map<string, NativeToolDefinition>();
	for (const file of snapshot.files) {
		if (!file.path.startsWith(TOOL_DEFINITION_PREFIX) || !/\.ya?ml$/u.test(file.path)) continue;
		const definition = parseToolDefinition(parseHarnessYaml(file.content), file.path);
		if (byName.has(definition.name)) throw new Error(`vendored tool name ${definition.name} is defined twice`);
		byName.set(definition.name, definition);
	}
	return byName;
}

function selectedMode(lock: JsonRecord): { mode: string; toolNames: readonly string[] } {
	const sequence = nativeLockValue(lock, "loop.sequence");
	if (!Array.isArray(sequence) || sequence.length !== 1 || !isRecord(sequence[0])) {
		// Multi-stage sequences need the turn seam from ticket 22.
		throw new Error("native harness supports exactly one loop.sequence stage");
	}
	const mode = requiredString(sequence[0].mode, "loop.sequence[0].mode");
	const modes = nativeLockValue(lock, "modes");
	if (!Array.isArray(modes)) throw new Error("native harness lock has no modes");
	const selected = modes.find(candidate => isRecord(candidate) && candidate.name === mode);
	if (!isRecord(selected) || !Array.isArray(selected.tools_enabled)) {
		throw new Error(`native harness mode ${mode} has no tools_enabled list`);
	}
	return {
		mode,
		toolNames: selected.tools_enabled.map((name, index) => requiredString(name, `${mode}.tools_enabled[${index}]`)),
	};
}

function caseInsensitiveOrder(left: NativeToolDefinition, right: NativeToolDefinition): number {
	const a = left.name.toLowerCase();
	const b = right.name.toLowerCase();
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Build the locked mode's tool surface from the vendored definitions. `native` lists the tools the
 * Python reference sends through provider function calling, in its registry order; `textInvoked`
 * lists the enabled tools it offers only through its text-call dialect.
 */
export async function loadNativeToolSurface(lock: JsonRecord): Promise<NativeToolSurfacePack> {
	const { mode, toolNames } = selectedMode(lock);
	const definitions = await vendoredToolDefinitions();
	const enabled = toolNames.map(name => {
		const definition = definitions.get(name);
		if (definition === undefined) throw new Error(`native harness tool ${name} has no vendored definition`);
		return definition;
	});
	const ordered = [...enabled].sort(caseInsensitiveOrder);
	return Object.freeze({
		mode,
		native: Object.freeze(ordered.filter(tool => tool.nativePrimary)),
		textInvoked: Object.freeze(ordered.filter(tool => !tool.nativePrimary)),
	});
}

/** Provider function-tool payload for one native tool, as the Python reference serializes it. */
export function nativeFunctionTool(tool: NativeToolDefinition): JsonRecord {
	const fn: Record<string, CanonicalJson> = { name: tool.name, description: tool.description, parameters: tool.parameters };
	if (tool.strict !== undefined) fn.strict = tool.strict;
	return { type: "function", function: fn };
}
