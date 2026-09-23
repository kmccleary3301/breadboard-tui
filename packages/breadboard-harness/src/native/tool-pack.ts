import { parse as parseYaml } from "yaml";
import { readEngineDataFile } from "../index";
import type { CanonicalJson } from "../canonical-json";
import { nativeLockValue } from "./prompt-pack";
import type { NativeJsonSchema, NativeToolDefinition, NativeToolParameter, NativeToolSurfacePack } from "./types";

const R39_TOOL_FILES: Readonly<Record<string, string>> = {
	read_file: "read_file.yaml",
	list_dir: "list_dir.yaml",
	apply_unified_patch: "apply_unified_patch.yaml",
	create_file_from_block: "create_file_from_block.yaml",
	run_shell: "run_shell.yaml",
	eval: "eval.yaml",
	TodoWrite: "todo_write.yaml",
	mark_task_complete: "mark_task_complete.yaml",
};

type YamlRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown, label: string): YamlRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`tool definition ${label} must be an object`);
	return value as YamlRecord;
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`tool definition ${label} must be a non-empty string`);
	return value;
}

function jsonValue(value: unknown): CanonicalJson {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (Array.isArray(value)) return value.map(item => jsonValue(item));
	if (typeof value === "object") {
		const result: Record<string, CanonicalJson> = {};
		for (const [key, item] of Object.entries(value)) {
			if (item !== undefined) result[key] = jsonValue(item);
		}
		return result;
	}
	throw new Error("tool definition contains an unsupported YAML value");
}

function parameterSchema(parameter: NativeToolParameter): NativeJsonSchema {
	const schema: Record<string, CanonicalJson> = { type: parameter.type };
	if (parameter.description !== undefined) schema.description = parameter.description;
	if (parameter.enum !== undefined) schema.enum = [...parameter.enum];
	if (parameter.minimum !== undefined) schema.minimum = parameter.minimum;
	if (parameter.default !== undefined) schema.default = parameter.default;
	if (parameter.items !== undefined) schema.items = parameter.items;
	if (parameter.properties !== undefined) schema.properties = parameter.properties;
	return schema;
}

function parseParameter(value: unknown, toolName: string): NativeToolParameter {
	const parameter = asRecord(value, `${toolName}.parameters[]`);
	const parameterType = requiredString(parameter.type, `${toolName}.parameters[].type`);
	const itemValue = parameter.items;
	const items =
		itemValue === undefined
			? undefined
			: (() => {
					const itemRecord = asRecord(itemValue, `${toolName}.parameters[].items`);
					return {
						type: requiredString(itemRecord.type, `${toolName}.parameters[].items.type`),
						...(typeof itemRecord.description === "string" ? { description: itemRecord.description } : {}),
					};
				})();
	return {
		name: requiredString(parameter.name, `${toolName}.parameters[].name`),
		type: parameterType,
		...(typeof parameter.description === "string" ? { description: parameter.description } : {}),
		...(typeof parameter.required === "boolean" ? { required: parameter.required } : {}),
		...(parameter.default !== undefined ? { default: jsonValue(parameter.default) } : {}),
		...(Array.isArray(parameter.enum) ? { enum: parameter.enum.map(item => requiredString(item, `${toolName}.enum[]`)) } : {}),
		...(typeof parameter.minimum === "number" ? { minimum: parameter.minimum } : {}),
		...(items === undefined ? {} : { items }),
	};
}

function parseToolDefinition(value: unknown): NativeToolDefinition {
	const source = asRecord(value, "root");
	const name = requiredString(source.name, "name");
	const parameters = Array.isArray(source.parameters) ? source.parameters.map(parameter => parseParameter(parameter, name)) : [];
	const properties: Record<string, CanonicalJson> = {};
	const required: string[] = [];
	for (const parameter of parameters) {
		properties[parameter.name] = parameterSchema(parameter);
		if (parameter.required === true) required.push(parameter.name);
	}
	const schema: Record<string, CanonicalJson> = {
		type: "object",
		properties,
		additionalProperties: false,
	};
	if (required.length > 0) schema.required = required;
	const execution = asRecord(source.execution ?? {}, `${name}.execution`);
	const classification = asRecord(source.classification ?? {}, `${name}.classification`);
	return Object.freeze({
		id: requiredString(source.id, `${name}.id`),
		name,
		description: requiredString(source.description, `${name}.description`),
		aliases: Array.isArray(source.aliases) ? source.aliases.map(alias => requiredString(alias, `${name}.aliases[]`)) : [],
		parameters,
		schema,
		...(typeof execution.max_per_turn === "number" ? { maxPerTurn: execution.max_per_turn } : {}),
		readonly: classification.readonly === true,
		blocking: execution.blocking === true,
	});
}

function selectedToolNames(lock: Readonly<Record<string, CanonicalJson>>): { mode: string; names: string[] } {
	const sequence = nativeLockValue(lock, "loop.sequence");
	const first = Array.isArray(sequence) ? sequence[0] : undefined;
	const mode = typeof first === "object" && first !== null && !Array.isArray(first) && typeof first.mode === "string" ? first.mode : undefined;
	if (mode === undefined) throw new Error("native harness lock has no loop.sequence mode");
	const modes = nativeLockValue(lock, "modes");
	if (!Array.isArray(modes)) throw new Error("native harness lock has no modes");
	const selected = modes.find(candidate => typeof candidate === "object" && candidate !== null && !Array.isArray(candidate) && candidate.name === mode);
	if (typeof selected !== "object" || selected === null || Array.isArray(selected) || !Array.isArray(selected.tools_enabled)) {
		throw new Error(`native harness lock mode ${mode} has no tools_enabled list`);
	}
	const names = selected.tools_enabled.map((name: CanonicalJson) => requiredString(name, `${mode}.tools_enabled[]`));
	return { mode, names };
}

/** Build the model-facing R39 pack from the generated engine-data snapshot. */
export async function loadNativeToolSurface(lock: Readonly<Record<string, CanonicalJson>>): Promise<NativeToolSurfacePack> {
	const selected = selectedToolNames(lock);
	const tools: NativeToolDefinition[] = [];
	for (const name of selected.names) {
		const file = R39_TOOL_FILES[name];
		if (file === undefined) throw new Error(`native harness tool ${name} has no vendored snapshot definition`);
		const source = await readEngineDataFile(`implementations/tools/defs/${file}`);
		tools.push(parseToolDefinition(parseYaml(source)));
	}
	const byName = new Map(tools.map(tool => [tool.name, tool]));
	return Object.freeze({ mode: selected.mode, tools: Object.freeze(tools), byName });
}

export { R39_TOOL_FILES };
