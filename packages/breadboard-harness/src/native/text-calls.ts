import type { CanonicalJson, JsonRecord } from "../canonical-json";
import { isJsonRecord } from "../canonical-json";
import type { NativeToolDefinition } from "./types";

type ParseValue = { readonly ok: true; readonly value: CanonicalJson } | { readonly ok: false };
type ToolShape = { readonly definition: NativeToolDefinition; readonly parameters: readonly string[] };

const ALIASES: Readonly<Record<string, string>> = {
	generalbashcommands: "Bash",
	aidersearchreplace: "apply_search_replace",
	unifieddiffgitlike: "apply_unified_patch",
	bashcommands: "Bash",
};

function normalizeName(rawName: string, tools: readonly ToolShape[]): string | undefined {
	const exact = tools.find(({ definition }) => definition.name === rawName);
	if (exact) return exact.definition.name;
	const cleaned = rawName.toLowerCase().replace(/[^a-z0-9]+/g, "");
	const alias = ALIASES[cleaned];
	if (alias && tools.some(({ definition }) => definition.name === alias)) return alias;
	return tools.find(({ definition }) => definition.name.toLowerCase().replace(/[^a-z0-9]+/g, "") === cleaned)
		?.definition.name;
}

function isWhitespace(value: string): boolean {
	return /\s/.test(value);
}

function matchingDelimiter(source: string, start: number): number | undefined {
	const stack: string[] = [];
	let quote = "";
	let triple = false;
	let escaped = false;
	for (let index = start; index < source.length; index += 1) {
		const character = source[index];
		if (quote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === "\\") {
				escaped = true;
				continue;
			}
			if (triple ? source.startsWith(quote.repeat(3), index) : character === quote) {
				if (triple) index += 2;
				quote = "";
				triple = false;
			}
			continue;
		}
		if (character === '"' || character === "'") {
			triple = source.startsWith(character.repeat(3), index);
			quote = character;
			if (triple) index += 2;
			continue;
		}
		if (character === "(" || character === "[" || character === "{") {
			stack.push(character);
			continue;
		}
		if (character === ")" || character === "]" || character === "}") {
			const expected = character === ")" ? "(" : character === "]" ? "[" : "{";
			if (stack.at(-1) !== expected) return undefined;
			stack.pop();
			if (stack.length === 0) return index;
		}
	}
	return undefined;
}

function splitTopLevel(source: string, delimiter: string): string[] | undefined {
	const parts: string[] = [];
	let start = 0;
	let quote = "";
	let triple = false;
	let escaped = false;
	const stack: string[] = [];
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		if (quote) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === "\\") {
				escaped = true;
				continue;
			}
			if (triple ? source.startsWith(quote.repeat(3), index) : character === quote) {
				if (triple) index += 2;
				quote = "";
				triple = false;
			}
			continue;
		}
		if (character === '"' || character === "'") {
			triple = source.startsWith(character.repeat(3), index);
			quote = character;
			if (triple) index += 2;
			continue;
		}
		if (character === "(" || character === "[" || character === "{") {
			stack.push(character);
			continue;
		}
		if (character === ")" || character === "]" || character === "}") {
			const expected = character === ")" ? "(" : character === "]" ? "[" : "{";
			if (stack.at(-1) !== expected) return undefined;
			stack.pop();
			continue;
		}
		if (character === delimiter && stack.length === 0) {
			parts.push(source.slice(start, index));
			start = index + 1;
		}
	}
	if (quote || stack.length !== 0) return undefined;
	parts.push(source.slice(start));
	return parts;
}

function decodeString(source: string): ParseValue {
	const match = source.match(/^(?:[rRuU])?(\"\"\"|'''|\"|')([\s\S]*)\1$/);
	if (!match) return { ok: false };
	const quote = match[1];
	const body = match[2];
	if (quote.length === 1 && body.includes("\n")) return { ok: false };
	if (quote.length === 1 && body.endsWith("\\")) return { ok: false };
	const rawPrefix = /^(?:[rR])/.test(source);
	if (rawPrefix) return { ok: true, value: body };
	let result = "";
	for (let index = 0; index < body.length; index += 1) {
		const character = body[index];
		if (character !== "\\") {
			result += character;
			continue;
		}
		if (index + 1 >= body.length) return { ok: false };
		const escaped = body[++index];
		const simple: Record<string, string> = {
			a: "\u0007",
			b: "\b",
			f: "\f",
			n: "\n",
			r: "\r",
			t: "\t",
			v: "\u000b",
			"\\": "\\",
			"'": "'",
			'"': '"',
		};
		if (escaped in simple) {
			result += simple[escaped];
			continue;
		}
		if (escaped === "u" || escaped === "U") {
			const size = escaped === "u" ? 4 : 8;
			const digits = body.slice(index + 1, index + 1 + size);
			if (!new RegExp(`^[0-9a-fA-F]{${size}}$`).test(digits)) return { ok: false };
			result += String.fromCodePoint(Number.parseInt(digits, 16));
			index += size;
			continue;
		}
		if (escaped === "x") {
			const digits = body.slice(index + 1, index + 3);
			if (!/^[0-9a-fA-F]{2}$/.test(digits)) return { ok: false };
			result += String.fromCodePoint(Number.parseInt(digits, 16));
			index += 2;
			continue;
		}
		// Python preserves the character for an unrecognised escape.
		result += escaped;
	}
	return { ok: true, value: result };
}

function parseLiteral(source: string): ParseValue {
	const trimmed = source.trim();
	if (trimmed === "") return { ok: false };
	const stringValue = decodeString(trimmed);
	if (stringValue.ok) return stringValue;
	if (trimmed === "True") return { ok: true, value: true };
	if (trimmed === "False") return { ok: true, value: false };
	if (trimmed === "None") return { ok: true, value: null };
	if (/^[+-]?\d+$/.test(trimmed)) return { ok: true, value: Number(trimmed) };
	if (/^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return { ok: true, value: Number(trimmed) };
	if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
		const open = trimmed[0];
		const close = open === "[" ? "]" : "}";
		if (matchingDelimiter(trimmed, 0) !== trimmed.length - 1) return { ok: false };
		const inner = trimmed.slice(1, -1).trim();
		if (open === "[") {
			if (!inner) return { ok: true, value: [] };
			const parts = splitTopLevel(inner, ",");
			if (!parts) return { ok: false };
			const values: CanonicalJson[] = [];
			for (const part of parts) {
				if (!part.trim()) continue;
				const parsed = parseLiteral(part);
				if (!parsed.ok) return { ok: false };
				values.push(parsed.value);
			}
			return { ok: true, value: values };
		}
		if (close !== "}") return { ok: false };
		const record: JsonRecord = {};
		if (!inner) return { ok: true, value: record };
		const parts = splitTopLevel(inner, ",");
		if (!parts) return { ok: false };
		for (const part of parts) {
			if (!part.trim()) continue;
			const colon = splitTopLevel(part, ":");
			if (!colon || colon.length !== 2) return { ok: false };
			const key = parseLiteral(colon[0]);
			const value = parseLiteral(colon[1]);
			if (!key.ok || typeof key.value !== "string" || !value.ok) return { ok: false };
			record[key.value] = value.value;
		}
		return { ok: true, value: record };
	}
	if (trimmed.startsWith("(") && trimmed.endsWith(")") && matchingDelimiter(trimmed, 0) === trimmed.length - 1) {
		return parseLiteral(trimmed.slice(1, -1));
	}
	return { ok: false };
}

function splitKeyword(source: string, delimiter: string): [string, string] | undefined {
	const parts = splitTopLevel(source, delimiter);
	if (!parts || parts.length < 2) return undefined;
	return [parts[0], parts.slice(1).join(delimiter)];
}

function parseCall(body: string, tool: ToolShape): JsonRecord | undefined {
	const leading = body.trim();
	const functionMatch = leading.match(/^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*/);
	if (!functionMatch) return undefined;
	const opening = functionMatch[0].length;
	if (leading[opening] !== "(") return undefined;
	const closing = matchingDelimiter(leading, opening);
	if (closing === undefined) return undefined;
	const argsSource = leading.slice(opening + 1, closing);
	const parts = argsSource.trim() ? splitTopLevel(argsSource, ",") : [];
	if (parts === undefined) return undefined;
	const argumentsRecord: JsonRecord = {};
	let positionalIndex = 0;
	for (const part of parts) {
		const argument = part.trim();
		if (!argument) continue;
		const keyword = splitKeyword(argument, "=") ?? splitKeyword(argument, ":");
		if (keyword) {
			const name = keyword[0].trim();
			if (!/^[A-Za-z_]\w*$/.test(name)) return undefined;
			const value = parseLiteral(keyword[1]);
			if (!value.ok) return undefined;
			argumentsRecord[name] = value.value;
			continue;
		}
		const value = parseLiteral(argument);
		if (!value.ok || positionalIndex >= tool.parameters.length) return undefined;
		argumentsRecord[tool.parameters[positionalIndex++]] = value.value;
	}
	return argumentsRecord;
}

function stableKey(value: CanonicalJson): string {
	if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
	if (isJsonRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map(key => `${JSON.stringify(key)}:${stableKey(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

/** Parse the Pythonic02 `<TOOL_CALL>` blocks. Invalid or unknown blocks are ignored like Python. */
export function parseTextToolCalls(
	assistantText: string,
	allowed: readonly NativeToolDefinition[],
): { calls: Array<{ name: string; arguments: JsonRecord }>; errors: string[] } {
	const tools: ToolShape[] = allowed.map(definition => {
		const properties = isJsonRecord(definition.parameters.properties) ? definition.parameters.properties : undefined;
		return { definition, parameters: properties ? Object.keys(properties) : [] };
	});
	const calls: Array<{ name: string; arguments: JsonRecord }> = [];
	const seen = new Set<string>();
	const blocks = /<TOOL_CALL>([\s\S]*?)<\/TOOL_CALL>/gi;
	for (const match of assistantText.matchAll(blocks)) {
		const body = match[1] ?? "";
		const functionMatch = body.trim().match(/^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/);
		if (!functionMatch) continue;
		const name = normalizeName(functionMatch[1], tools);
		if (!name) continue;
		const tool = tools.find(({ definition }) => definition.name === name);
		if (!tool) continue;
		const argumentsRecord = parseCall(body, tool);
		if (!argumentsRecord) continue;
		const key = `${name}|${stableKey(argumentsRecord)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		calls.push({ name, arguments: argumentsRecord });
	}
	return { calls, errors: [] };
}

function pythonJson(value: CanonicalJson): string {
	if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
	return `{${Object.entries(value)
		.map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`)
		.join(", ")}}`;
}

function pythonTruthy(value: CanonicalJson | undefined): boolean {
	if (value === undefined || value === null || value === false || value === "") return false;
	if (typeof value === "number") return value !== 0;
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === "object") return Object.keys(value).length > 0;
	return true;
}

/**
 * Render text-dialect results exactly as Python's MessageFormatter. The caller
 * appends this string as a `user` message (model_output.py:543-546), not a
 * provider `tool` message.
 */
export function formatTextToolResults(results: Array<{ name: string; output: JsonRecord }>): string {
	if (results.length === 0) return "(no tool output)";
	return results
		.map(({ name, output }) => {
			const selected = pythonTruthy(output.output)
				? output.output
				: pythonTruthy(output.__mvi_text_output)
					? output.__mvi_text_output
					: output;
			return `[${name}] ${pythonJson(selected)}`;
		})
		.join("\n\n");
}
