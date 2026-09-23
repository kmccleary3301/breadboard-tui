import { describe, expect, test } from "bun:test";

import { canonicalJson, graphContentHash, parseCanonicalJson } from "../src/canonical-json";

// Goldens produced by the Python reference encoder (`json.dumps(..., ensure_ascii=False, indent=2,
// separators=(",", ": "), sort_keys=True) + "\n"`, python3 3.x).
const PYTHON_FLOAT_REPRS: ReadonlyArray<readonly [string, string]> = [
	["0.1", "0.1"],
	["1.0", "1.0"],
	["-0.0", "-0.0"],
	["1e-05", "1e-05"],
	["0.0001", "0.0001"],
	["1e+16", "1e+16"],
	["9999999999999998.0", "9999999999999998.0"],
	["1.5e+300", "1.5e+300"],
	["5e-324", "5e-324"],
	["0.30000000000000004", "0.30000000000000004"],
	["1e+22", "1e+22"],
	["1.25e-07", "1.25e-07"],
];

const RECORD =
	'{"graph_hash":"x","b":[1,2.0,{"z":null,"a":true}],"\\ud83d\\ude00k":1,"\\uffffk":2,"esc":"q\\"\\\\\\n\\t\\u0001\\u007f\\u2028\\u00e9","empty":{},"el":[],"n":-3,"f":[1e-05,0.5,1e16]}';
const RECORD_GRAPH_HASH = "sha256:10902c40a4808476f84a8c75bf450e350eb4a140001dd6e9ee839796cfa1c2a2";

describe("canonical JSON", () => {
	test("floats print as Python repr and integers stay integers", () => {
		for (const [source, repr] of PYTHON_FLOAT_REPRS) {
			expect(canonicalJson(parseCanonicalJson(source))).toBe(`${repr}\n`);
		}
		expect(canonicalJson(parseCanonicalJson("[2, 2.0]"))).toBe("[\n  2,\n  2.0\n]\n");
	});

	test("graph hash matches Python over key order, escapes, nesting and empty containers", () => {
		const record = parseCanonicalJson(RECORD) as { readonly [key: string]: never };
		expect(graphContentHash(record)).toBe(RECORD_GRAPH_HASH);
	});

	test("rejects values Python cannot encode", () => {
		expect(() => canonicalJson("\ud800")).toThrow(/surrogate/);
		expect(() => canonicalJson(Number.NaN)).toThrow();
	});
});
