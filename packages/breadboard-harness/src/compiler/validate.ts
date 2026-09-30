import { compareCodePoints, JsonFloat } from "../canonical-json";
import { bundledEngineDataSnapshot } from "../engine-data";

export interface HarnessValidationFinding {
	readonly pointer: string;
	readonly code: string;
	readonly message?: string;
}

type JsonSchema = { readonly [key: string]: unknown };
type PathPart = string | number;
type RawError = {
	readonly path: readonly PathPart[];
	readonly validator: string;
	readonly validatorValue: unknown;
	readonly schema: JsonSchema;
	readonly context?: readonly RawError[];
};

const CANONICAL_SCHEMA_ID = "https://breadboard.dev/contracts/public/schemas/bb.harness_definition.v1.schema.json";
const LEGACY_SCHEMA_ID = "https://breadboard.dev/contracts/kernel/schemas/bb.agent_config_surface.v2.schema.json";
const MAX_JSON_INTEGER_DIGITS = 640;

function pathPointer(path: readonly PathPart[]): string {
	if (path.length === 0) return "/";
	return `/${path.map(part => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function jsonText(value: unknown): string {
	if (value instanceof JsonFloat) return String(value.value);
	return JSON.stringify(value, (_key, item) => (item instanceof JsonFloat ? item.value : item));
}

function sameJson(left: unknown, right: unknown): boolean {
	if (left instanceof JsonFloat) return typeof right === "number" && left.value === right;
	if (right instanceof JsonFloat) return typeof left === "number" && right.value === left;
	if (left === right) return true;
	if (typeof left !== typeof right || left === null || right === null) return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
		return left.every((item, index) => sameJson(item, right[index]));
	}
	if (typeof left === "object" && typeof right === "object") {
		const leftKeys = Object.keys(left as object).sort(compareCodePoints);
		const rightKeys = Object.keys(right as object).sort(compareCodePoints);
		return (
			leftKeys.length === rightKeys.length &&
			leftKeys.every(
				(key, index) =>
					key === rightKeys[index] &&
					sameJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
			)
		);
	}
	return false;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof JsonFloat);
}

function numericValue(value: unknown): number | undefined {
	if (value instanceof JsonFloat) return value.value;
	if (typeof value === "number") return value;
	if (typeof value === "bigint") return Number(value);
	return undefined;
}

function isInteger(value: unknown): boolean {
	if (value instanceof JsonFloat) return Number.isInteger(value.value);
	return (typeof value === "number" && Number.isInteger(value)) || typeof value === "bigint";
}

function isPythonInteger(value: unknown): boolean {
	if (value instanceof JsonFloat) return false;
	return (typeof value === "number" && Number.isInteger(value)) || typeof value === "bigint";
}

function acceptsType(value: unknown, type: string): boolean {
	switch (type) {
		case "null":
			return value === null;
		case "boolean":
			return typeof value === "boolean";
		case "string":
			return typeof value === "string";
		case "number":
			return (
				(typeof value === "number" && Number.isFinite(value)) ||
				value instanceof JsonFloat ||
				typeof value === "bigint"
			);
		case "integer":
			return isInteger(value);
		case "array":
			return Array.isArray(value);
		case "object":
			return isObject(value);
		default:
			return true;
	}
}

const SCHEMA_SCOPE = new WeakMap<object, JsonSchema>();

function recordSchemaScope(value: unknown, root: JsonSchema): void {
	if (!value || typeof value !== "object" || SCHEMA_SCOPE.has(value)) return;
	SCHEMA_SCOPE.set(value, root);
	if (Array.isArray(value)) {
		for (const item of value) recordSchemaScope(item, root);
		return;
	}
	for (const child of Object.values(value)) recordSchemaScope(child, root);
}

let schemaTable: ReadonlyMap<string, JsonSchema> | undefined;

/** The bundled schemas by `$id`, parsed on first use so importing the compiler costs nothing. */
function schemas(): ReadonlyMap<string, JsonSchema> {
	if (schemaTable !== undefined) return schemaTable;
	const table = new Map<string, JsonSchema>();
	for (const file of bundledEngineDataSnapshot().files) {
		if (!file.path.endsWith(".schema.json")) continue;
		const schema = JSON.parse(file.content) as JsonSchema;
		if (typeof schema.$id === "string") table.set(schema.$id, schema);
	}
	for (const schema of table.values()) recordSchemaScope(schema, schema);
	schemaTable = table;
	return table;
}

function resolveRef(ref: string, root: JsonSchema): JsonSchema {
	const separator = ref.indexOf("#");
	const base = separator < 0 ? ref : ref.slice(0, separator);
	const fragment = separator < 0 ? "" : ref.slice(separator + 1);
	// A relative reference resolves against the enclosing schema's `$id` (Draft 2020-12 §8.2.1).
	const id = base.length === 0 || typeof root.$id !== "string" ? base : new URL(base, root.$id).href;
	const target = base.length === 0 ? root : schemas().get(id);
	if (target === undefined) throw new Error(`Unknown schema reference: ${ref}`);
	let value: unknown = target;
	if (fragment.startsWith("/")) {
		for (const part of fragment.slice(1).split("/")) {
			if (!isObject(value)) throw new Error(`Invalid schema reference: ${ref}`);
			value = value[part.replaceAll("~1", "/").replaceAll("~0", "~")];
		}
	}
	if (!isObject(value)) throw new Error(`Schema reference is not an object: ${ref}`);
	return value;
}

function dereference(schema: JsonSchema, root: JsonSchema): JsonSchema {
	let current = schema;
	const seen = new Set<JsonSchema>();
	while (typeof current.$ref === "string" && !seen.has(current)) {
		seen.add(current);
		const localRoot = SCHEMA_SCOPE.get(current) ?? root;
		current = resolveRef(current.$ref, localRoot);
	}
	return current;
}

function schemaType(schema: JsonSchema): string[] {
	const type = schema.type;
	if (typeof type === "string") return [type];
	if (Array.isArray(type)) return type.filter((item): item is string => typeof item === "string");
	return [];
}

function constraintMessage(validator: string, validatorValue: unknown): string {
	const value = jsonText(validatorValue);
	switch (validator) {
		case "type":
			return `Value must have type ${value}`;
		case "const":
			return `Value must equal ${value}`;
		case "enum":
			return `Value must be one of ${value}`;
		case "minItems":
			return `Array must contain at least ${value} item(s)`;
		case "maxItems":
			return `Array must contain at most ${value} item(s)`;
		case "minLength":
			return `String must contain at least ${value} character(s)`;
		case "maxLength":
			return `String must contain at most ${value} character(s)`;
		case "oneOf":
			return "Value must match exactly one allowed schema";
		case "anyOf":
			return "Value must match at least one allowed schema";
		case "not":
			return "Value must not match the disallowed schema";
		default:
			return `Value violates ${validator} constraint ${value}`;
	}
}

function error(
	path: readonly PathPart[],
	validator: string,
	validatorValue: unknown,
	schema: JsonSchema,
	context?: readonly RawError[],
): RawError {
	return { path, validator, validatorValue, schema, ...(context === undefined ? {} : { context }) };
}

function validateSchema(
	value: unknown,
	rawSchema: JsonSchema,
	path: readonly PathPart[],
	root: JsonSchema,
): RawError[] {
	const schema = dereference(rawSchema, root);
	const errors: RawError[] = [];
	const types = schemaType(schema);
	if (types.length > 0 && !types.some(type => acceptsType(value, type))) {
		errors.push(error(path, "type", schema.type, schema));
	}
	if ("const" in schema && !sameJson(value, schema.const)) errors.push(error(path, "const", schema.const, schema));
	if (Array.isArray(schema.enum) && !schema.enum.some(item => sameJson(value, item)))
		errors.push(error(path, "enum", schema.enum, schema));
	const numeric = numericValue(value);
	if (numeric !== undefined && typeof schema.minimum === "number" && numeric < schema.minimum)
		errors.push(error(path, "minimum", schema.minimum, schema));
	if (numeric !== undefined && typeof schema.maximum === "number" && numeric > schema.maximum)
		errors.push(error(path, "maximum", schema.maximum, schema));
	if (numeric !== undefined && typeof schema.exclusiveMinimum === "number" && numeric <= schema.exclusiveMinimum)
		errors.push(error(path, "exclusiveMinimum", schema.exclusiveMinimum, schema));
	if (numeric !== undefined && typeof schema.exclusiveMaximum === "number" && numeric >= schema.exclusiveMaximum)
		errors.push(error(path, "exclusiveMaximum", schema.exclusiveMaximum, schema));
	if (numeric !== undefined && typeof schema.multipleOf === "number" && numeric % schema.multipleOf !== 0)
		errors.push(error(path, "multipleOf", schema.multipleOf, schema));
	if (typeof schema.minLength === "number" && typeof value === "string" && [...value].length < schema.minLength)
		errors.push(error(path, "minLength", schema.minLength, schema));
	if (typeof schema.maxLength === "number" && typeof value === "string" && [...value].length > schema.maxLength)
		errors.push(error(path, "maxLength", schema.maxLength, schema));
	if (typeof schema.pattern === "string" && typeof value === "string") {
		try {
			if (!new RegExp(schema.pattern, "u").test(value)) errors.push(error(path, "pattern", schema.pattern, schema));
		} catch {
			// Bundled schemas contain only valid regular expressions.
		}
	}
	if (typeof schema.minItems === "number" && Array.isArray(value) && value.length < schema.minItems)
		errors.push(error(path, "minItems", schema.minItems, schema));
	if (typeof schema.maxItems === "number" && Array.isArray(value) && value.length > schema.maxItems)
		errors.push(error(path, "maxItems", schema.maxItems, schema));
	if (Array.isArray(schema.allOf)) {
		for (const branch of schema.allOf)
			if (isObject(branch)) errors.push(...validateSchema(value, branch, path, root));
	}
	for (const keyword of ["anyOf", "oneOf"] as const) {
		const branches = schema[keyword];
		if (!Array.isArray(branches)) continue;
		const branchErrors = branches.map(branch => (isObject(branch) ? validateSchema(value, branch, path, root) : []));
		const passing = branchErrors.filter(item => item.length === 0).length;
		const valid = keyword === "oneOf" ? passing === 1 : passing > 0;
		if (!valid) {
			const compatible = branchErrors.filter(
				items => !items.some(item => item.validator === "type" && item.path.length === path.length),
			);
			if (compatible.length > 0) {
				errors.push(error(path, keyword, branches, schema, compatible.flat()));
			} else {
				errors.push(error(path, keyword, branches, schema));
			}
		}
	}
	if (isObject(value)) {
		const properties = isObject(schema.properties) ? schema.properties : {};
		if (Array.isArray(schema.required)) {
			for (const name of [...schema.required]
				.filter((item): item is string => typeof item === "string")
				.sort(compareCodePoints)) {
				if (!Object.hasOwn(value, name)) errors.push(error([...path, name], "required", name, schema));
			}
		}
		if (schema.additionalProperties === false) {
			const patterns = isObject(schema.patternProperties)
				? Object.keys(schema.patternProperties).map(pattern => new RegExp(pattern, "u"))
				: [];
			for (const name of Object.keys(value).sort(compareCodePoints)) {
				if (!Object.hasOwn(properties, name) && !patterns.some(pattern => pattern.test(name))) {
					errors.push(error([...path, name], "additionalProperties", name, schema));
				}
			}
		}
		for (const name of Object.keys(value)) {
			const child = Object.hasOwn(properties, name) ? properties[name] : undefined;
			if (isObject(child)) errors.push(...validateSchema(value[name], child, [...path, name], root));
		}
		if (isObject(schema.additionalProperties)) {
			for (const name of Object.keys(value))
				if (!Object.hasOwn(properties, name))
					errors.push(...validateSchema(value[name], schema.additionalProperties, [...path, name], root));
		}
		if (isObject(schema.patternProperties)) {
			for (const [pattern, child] of Object.entries(schema.patternProperties)) {
				if (!isObject(child)) continue;
				const matcher = new RegExp(pattern, "u");
				for (const name of Object.keys(value))
					if (matcher.test(name)) errors.push(...validateSchema(value[name], child, [...path, name], root));
			}
		}
	}
	if (Array.isArray(value) && isObject(schema.items)) {
		for (const [index, item] of value.entries())
			errors.push(...validateSchema(item, schema.items, [...path, index], root));
	}
	return errors;
}

function requiredFinding(raw: RawError): HarnessValidationFinding[] {
	return [
		{
			pointer: pathPointer(raw.path),
			code: "required",
			message: `'${String(raw.validatorValue)}' is a required property`,
		},
	];
}

function additionalFinding(raw: RawError): HarnessValidationFinding[] {
	const key = String(raw.validatorValue);
	return [
		{
			pointer: pathPointer(raw.path),
			code: "additionalProperties",
			message: `Additional property '${key.replaceAll("'", "\\'")}' is not allowed`,
		},
	];
}

function transformError(raw: RawError): HarnessValidationFinding[] {
	if (raw.context !== undefined) {
		const compatible = raw.context.length > 0 ? raw.context : [];
		if (compatible.length > 0) return compatible.flatMap(transformError);
	}
	if (raw.validator === "required") return requiredFinding(raw);
	if (raw.validator === "additionalProperties") return additionalFinding(raw);
	return [
		{
			pointer: pathPointer(raw.path),
			code: raw.validator,
			message: constraintMessage(raw.validator, raw.validatorValue),
		},
	];
}

function sortFindings(findings: readonly HarnessValidationFinding[]): HarnessValidationFinding[] {
	return [
		...new Map(findings.map(item => [`${item.pointer}\u0000${item.code}\u0000${item.message ?? ""}`, item])).values(),
	].sort((left, right) => {
		const pointerOrder = compareCodePoints(left.pointer, right.pointer);
		if (pointerOrder !== 0) return pointerOrder;
		const codeOrder = compareCodePoints(left.code, right.code);
		if (codeOrder !== 0) return codeOrder;
		return compareCodePoints(left.message ?? "", right.message ?? "");
	});
}

function jsonDomainFindings(
	value: unknown,
	path: readonly PathPart[] = [],
	active = new Set<object>(),
): HarnessValidationFinding[] {
	if (path.length > 100)
		return [{ pointer: pathPointer(path), code: "json_depth", message: "JSON paths must not exceed 100 segments" }];
	if (value === null || typeof value === "boolean" || typeof value === "string") return [];
	if (value instanceof JsonFloat || typeof value === "number") {
		const numeric = value instanceof JsonFloat ? value.value : value;
		return Number.isFinite(numeric)
			? []
			: [{ pointer: pathPointer(path), code: "finite", message: "JSON numbers must be finite" }];
	}
	if (typeof value === "bigint") {
		return value.toString().replace(/^-/, "").length <= MAX_JSON_INTEGER_DIGITS
			? []
			: [
					{
						pointer: pathPointer(path),
						code: "integer_range",
						message: "JSON integers must contain at most 640 decimal digits",
					},
				];
	}
	if (Array.isArray(value) || isObject(value)) {
		if (active.has(value))
			return [{ pointer: pathPointer(path), code: "json_cycle", message: "JSON values must not contain cycles" }];
		active.add(value);
		const findings: HarnessValidationFinding[] = [];
		if (isObject(value)) {
			for (const key of Object.keys(value).sort(compareCodePoints))
				findings.push(...jsonDomainFindings(value[key], [...path, key], active));
		} else {
			for (const [index, item] of value.entries())
				findings.push(...jsonDomainFindings(item, [...path, index], active));
		}
		active.delete(value);
		return findings;
	}
	return [{ pointer: pathPointer(path), code: "json_type", message: "Value is not a JSON-domain value" }];
}

function sourcePairFindings(document: Record<string, unknown>): HarnessValidationFinding[] {
	const findings: HarnessValidationFinding[] = [];
	for (const name of ["schema_version", "version"] as const)
		if (!Object.hasOwn(document, name))
			findings.push({ pointer: `/${name}`, code: "required", message: `'${name}' is a required property` });
	if (findings.length > 0) return findings;
	const schemaVersion = document.schema_version;
	const version = document.version;
	const expected =
		typeof schemaVersion === "string"
			? (
					{
						"bb.harness_definition.v1": 1,
						"bb.agent_config_surface.v2": 2,
					} as Readonly<Record<string, number>>
				)[schemaVersion]
			: undefined;
	if (expected === undefined)
		findings.push({
			pointer: "/schema_version",
			code: "unsupported_schema_version",
			message:
				"Unsupported schema_version; expected one of 'bb.agent_config_surface.v2', 'bb.harness_definition.v1'",
		});
	if (expected !== undefined && (!isPythonInteger(version) || Number(version) !== expected))
		findings.push({
			pointer: "/version",
			code: "unsupported_version",
			message: `Version does not match schema_version; expected ${expected}`,
		});
	else if (expected === undefined && (!isPythonInteger(version) || ![1, 2].includes(Number(version))))
		findings.push({
			pointer: "/version",
			code: "unsupported_version",
			message: "Unsupported version; expected integer 1 or 2",
		});
	return findings;
}

export function validateHarnessDefinition(document: unknown): readonly HarnessValidationFinding[] {
	const domain = jsonDomainFindings(document);
	if (domain.length > 0) return sortFindings(domain);
	if (!isObject(document)) return [{ pointer: "/", code: "type", message: "Harness definition must be a mapping" }];
	const source = sourcePairFindings(document);
	if (source.length > 0) return sortFindings(source);
	const schemaVersion = document.schema_version;
	const version = Number(document.version);
	const root = schemas().get(
		schemaVersion === "bb.harness_definition.v1" && version === 1 ? CANONICAL_SCHEMA_ID : LEGACY_SCHEMA_ID,
	);
	if (root === undefined) throw new Error("Harness definition schemas are unavailable");
	const errors = validateSchema(document, root, [], root);
	return sortFindings(errors.flatMap(transformError));
}

export function hasHarnessValidationFindings(document: unknown): boolean {
	return validateHarnessDefinition(document).length > 0;
}

/**
 * Validate a JSON value against a bundled contract schema by `$id`, with the same Draft 2020-12 evaluator as
 * `validateHarnessDefinition`. Findings are sorted by pointer, then code; an empty list means the value conforms.
 */
export function validateBundledSchema(schemaId: string, value: unknown): readonly HarnessValidationFinding[] {
	const root = schemas().get(schemaId);
	if (root === undefined) throw new Error(`No bundled schema has $id ${schemaId}`);
	const domain = jsonDomainFindings(value);
	if (domain.length > 0) return sortFindings(domain);
	return sortFindings(validateSchema(value, root, [], root).flatMap(transformError));
}

export const harnessValidationKeywords = [
	"$ref",
	"type",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"minItems",
	"minLength",
	"pattern",
	"enum",
	"const",
	"minimum",
	"exclusiveMinimum",
	"oneOf",
] as const;
