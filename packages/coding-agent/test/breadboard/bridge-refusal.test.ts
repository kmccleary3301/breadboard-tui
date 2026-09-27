import { describe, expect, test } from "bun:test";
import {
	assertNoBridgeRequested,
	BreadboardBridgeRefusalError,
	detectBridgeRefusal,
	formatBridgeRefusal,
} from "../../src/breadboard/bridge-refusal";

describe("bridge refusal", () => {
	test("formats exact contract refusal message", () => {
		const message = formatBridgeRefusal("--engine-mode", "local-owned");
		expect(message).toBe(
			'bb: the Python engine bridge was removed; --engine-mode requests "local-owned". bb runs the native OMP loop; remove --engine-mode to use it.',
		);
	});

	test("refuses --engine-mode flag when requesting bridge modes", () => {
		for (const mode of ["local-owned", "local-external", "remote", "custom-bridge"]) {
			const refusal = detectBridgeRefusal({ cli: { engineMode: mode } });
			expect(refusal).toEqual({ source: "--engine-mode", value: mode });
			expect(() => assertNoBridgeRequested({ cli: { engineMode: mode } })).toThrow(BreadboardBridgeRefusalError);
		}
	});

	test("refuses --engine-mode passed in argv (spaced and equals)", () => {
		const spaced = detectBridgeRefusal({ argv: ["--engine-mode", "local-external", "hello"] });
		expect(spaced).toEqual({ source: "--engine-mode", value: "local-external" });

		const equals = detectBridgeRefusal({ argv: ["--engine-mode=remote", "hello"] });
		expect(equals).toEqual({ source: "--engine-mode", value: "remote" });

		// tokens after -- marker are ignored
		const afterMarker = detectBridgeRefusal({ argv: ["--", "--engine-mode", "local-owned"] });
		expect(afterMarker).toBeNull();
	});

	test("refuses --engine-url flag (cli and argv)", () => {
		const cli = detectBridgeRefusal({ cli: { engineUrl: "http://127.0.0.1:9099" } });
		expect(cli).toEqual({ source: "--engine-url", value: "http://127.0.0.1:9099" });

		const argv = detectBridgeRefusal({ argv: ["--engine-url=https://engine.example"] });
		expect(argv).toEqual({ source: "--engine-url", value: "https://engine.example" });
	});

	test("refuses BREADBOARD_ENGINE_MODE environment variable", () => {
		for (const mode of ["local-owned", "local-external", "remote"]) {
			const env = { BREADBOARD_ENGINE_MODE: mode };
			const refusal = detectBridgeRefusal({ environment: env });
			expect(refusal).toEqual({ source: "BREADBOARD_ENGINE_MODE", value: mode });
			expect(() => assertNoBridgeRequested({ environment: env })).toThrow(BreadboardBridgeRefusalError);
		}
	});

	test("refuses BREADBOARD_API_URL environment variable", () => {
		const env = { BREADBOARD_API_URL: "http://127.0.0.1:7777" };
		const refusal = detectBridgeRefusal({ environment: env });
		expect(refusal).toEqual({ source: "BREADBOARD_API_URL", value: "http://127.0.0.1:7777" });
		expect(() => assertNoBridgeRequested({ environment: env })).toThrow(BreadboardBridgeRefusalError);
	});

	test("refuses BREADBOARD_ENGINE_ARTIFACT environment variable", () => {
		const env = { BREADBOARD_ENGINE_ARTIFACT: "/path/to/engine.bundle" };
		const refusal = detectBridgeRefusal({ environment: env });
		expect(refusal).toEqual({ source: "BREADBOARD_ENGINE_ARTIFACT", value: "/path/to/engine.bundle" });
		expect(() => assertNoBridgeRequested({ environment: env })).toThrow(BreadboardBridgeRefusalError);
	});

	test("refuses breadboard.engineMode setting", () => {
		for (const mode of ["local-owned", "local-external", "remote"]) {
			const selectedConfig = { engineMode: mode };
			const refusal = detectBridgeRefusal({ selectedConfig });
			expect(refusal).toEqual({ source: "breadboard.engineMode", value: mode });
			expect(() => assertNoBridgeRequested({ selectedConfig })).toThrow(BreadboardBridgeRefusalError);
		}
	});

	test("refuses breadboard.baseUrl setting", () => {
		const selectedConfig = { baseUrl: "http://127.0.0.1:8080" };
		const refusal = detectBridgeRefusal({ selectedConfig });
		expect(refusal).toEqual({ source: "breadboard.baseUrl", value: "http://127.0.0.1:8080" });
		expect(() => assertNoBridgeRequested({ selectedConfig })).toThrow(BreadboardBridgeRefusalError);
	});

	test("refuses breadboard.engineArtifact setting", () => {
		const selectedConfig = { engineArtifact: "/old/bundle.tar.gz" };
		const refusal = detectBridgeRefusal({ selectedConfig });
		expect(refusal).toEqual({ source: "breadboard.engineArtifact", value: "/old/bundle.tar.gz" });
		expect(() => assertNoBridgeRequested({ selectedConfig })).toThrow(BreadboardBridgeRefusalError);
	});

	test("accepts native and off modes without refusal", () => {
		expect(detectBridgeRefusal({ cli: { engineMode: "native" } })).toBeNull();
		expect(detectBridgeRefusal({ cli: { engineMode: "off" } })).toBeNull();
		expect(detectBridgeRefusal({ argv: ["--engine-mode", "native"] })).toBeNull();
		expect(detectBridgeRefusal({ argv: ["--engine-mode=off"] })).toBeNull();
		expect(detectBridgeRefusal({ environment: { BREADBOARD_ENGINE_MODE: "native" } })).toBeNull();
		expect(detectBridgeRefusal({ environment: { BREADBOARD_ENGINE_MODE: "off" } })).toBeNull();
		expect(detectBridgeRefusal({ selectedConfig: { engineMode: "native" } })).toBeNull();
		expect(detectBridgeRefusal({ selectedConfig: { engineMode: "off" } })).toBeNull();
	});

	test("defaults cleanly when no bridge options are specified", () => {
		expect(detectBridgeRefusal({})).toBeNull();
		expect(detectBridgeRefusal({ environment: { BREADBOARD_PRODUCT: "1" } })).toBeNull();
	});
});
