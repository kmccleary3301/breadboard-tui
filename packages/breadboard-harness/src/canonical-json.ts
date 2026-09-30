/**
 * Byte-exact port of the Python reference's canonical JSON (`breadboard/product/harness/lock.py`
 * `canonical_json_bytes`): `json.dumps(allow_nan=False, ensure_ascii=False, indent=2,
 * separators=(",", ": "), sort_keys=True) + "\n"`, UTF-8. `graph_hash` is its sha256 with
 * `graph_hash: null`.
 */

/** A number Python holds as `float`; kept distinct so `1.0` does not print as `1`. */
export class JsonFloat {
	constructor(readonly value: number) {
		if (!Number.isFinite(value)) throw new Error(`canonical JSON rejects non-finite float ${value}`);
	}
}

export type CanonicalJson =
	| null
	| boolean
	| number
	| string
	| JsonFloat
	| readonly CanonicalJson[]
	| { readonly [key: string]: CanonicalJson };

/** A mutable-at-construction JSON object; the shape every parsed mapping takes. */
export type JsonRecord = { [key: string]: CanonicalJson };

/** Narrow a {@link CanonicalJson} value to its object arm. */
export function isJsonRecord(value: CanonicalJson | undefined): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof JsonFloat);
}

/** Parse JSON text, marking every number written with a fraction or exponent as a {@link JsonFloat}. */
export function parseCanonicalJson(text: string): CanonicalJson {
	return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) => {
		if (typeof value !== "number") return value;
		const source = context?.source;
		if (source === undefined) throw new Error("JSON.parse source text access is unavailable");
		return /[.eE]/.test(source) ? new JsonFloat(value) : value;
	}) as CanonicalJson;
}

/** Python `repr(float)`: shortest round-trip digits, exponent form when the exponent is < -4 or >= 16. */
export function pythonFloatRepr(value: number): string {
	if (!Number.isFinite(value)) throw new Error(`canonical JSON rejects non-finite float ${value}`);
	if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
	const sign = value < 0 ? "-" : "";
	const [mantissa, exponentText] = Math.abs(value).toExponential().split("e") as [string, string];
	const digits = mantissa.replace(".", "");
	const exponent = Number(exponentText);
	if (exponent < -4 || exponent >= 16) {
		const fraction = digits.length > 1 ? `.${digits.slice(1)}` : "";
		const magnitude = String(Math.abs(exponent)).padStart(2, "0");
		return `${sign}${digits[0]}${fraction}e${exponent < 0 ? "-" : "+"}${magnitude}`;
	}
	if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
	const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
	const fraction = digits.slice(exponent + 1);
	return `${sign}${whole}.${fraction === "" ? "0" : fraction}`;
}

/** Python `sorted()` order on `str`: code point, not UTF-16 unit. */
export function compareCodePoints(left: string, right: string): number {
	const a = [...left];
	const b = [...right];
	const length = Math.min(a.length, b.length);
	for (let index = 0; index < length; index++) {
		const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
		if (difference !== 0) return difference;
	}
	return a.length - b.length;
}

function encodeString(value: string): string {
	// Python raises when encoding a lone surrogate to UTF-8; JSON.stringify would escape it instead.
	if (!value.isWellFormed()) throw new Error("canonical JSON rejects strings with lone surrogates");
	// With ensure_ascii=False both escape exactly `"`, `\`, \b \f \n \r \t and other C0 controls as lowercase \u00xx.
	return JSON.stringify(value);
}

function encode(value: CanonicalJson, indent: string, out: string[]): void {
	if (value === null) out.push("null");
	else if (typeof value === "boolean") out.push(value ? "true" : "false");
	else if (typeof value === "string") out.push(encodeString(value));
	else if (typeof value === "number") {
		if (Number.isInteger(value)) {
			if (!Number.isSafeInteger(value)) throw new Error(`canonical JSON integer is not exact: ${value}`);
			out.push(Object.is(value, -0) ? "0" : String(value));
		} else out.push(pythonFloatRepr(value));
	} else if (value instanceof JsonFloat) out.push(pythonFloatRepr(value.value));
	else if (Array.isArray(value)) {
		if (value.length === 0) {
			out.push("[]");
			return;
		}
		const inner = `${indent}  `;
		out.push("[");
		value.forEach((item, index) => {
			out.push(index === 0 ? "\n" : ",\n", inner);
			encode(item, inner, out);
		});
		out.push("\n", indent, "]");
	} else {
		const keys = Object.keys(value).sort(compareCodePoints);
		if (keys.length === 0) {
			out.push("{}");
			return;
		}
		const inner = `${indent}  `;
		const record = value as { readonly [key: string]: CanonicalJson };
		out.push("{");
		keys.forEach((key, index) => {
			const item = record[key];
			if (item === undefined) throw new Error(`canonical JSON value for key ${key} is undefined`);
			out.push(index === 0 ? "\n" : ",\n", inner, encodeString(key), ": ");
			encode(item, inner, out);
		});
		out.push("\n", indent, "}");
	}
}

/** Canonical text, including the trailing newline. */
export function canonicalJson(value: CanonicalJson): string {
	const out: string[] = [];
	encode(value, "", out);
	out.push("\n");
	return out.join("");
}

/** `sha256:<hex>` of the canonical UTF-8 bytes. */
export function sha256Json(value: CanonicalJson): string {
	return `sha256:${new Bun.CryptoHasher("sha256").update(canonicalJson(value)).digest("hex")}`;
}

/** Python `graph_content_hash`: the record's canonical hash with `graph_hash` set to null. */
export function graphContentHash(record: { readonly [key: string]: CanonicalJson }): string {
	return sha256Json({ ...record, graph_hash: null });
}
