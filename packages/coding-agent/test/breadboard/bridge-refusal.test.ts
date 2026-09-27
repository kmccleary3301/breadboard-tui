import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

describe("bb refuses bridge settings before any subcommand opens state", () => {
	const packageRoot = path.resolve(import.meta.dir, "../..");

	async function runBb(args: readonly string[], root: string) {
		const child = Bun.spawn([process.execPath, "src/bb.ts", ...args], {
			cwd: packageRoot,
			env: {
				PATH: Bun.env.PATH ?? "/usr/bin:/bin",
				HOME: root,
				PI_CODING_AGENT_DIR: path.join(root, "agent"),
				BREADBOARD_CONFIG_DIR: path.join(root, "config"),
				BREADBOARD_PRODUCT: "1",
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, exitCode };
	}

	test("a --config overlay requesting the bridge stops `models`, `config` and `-p` with exit 2", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-settings-refusal-"));
		try {
			const overlay = path.join(root, "bridge.yml");
			fs.writeFileSync(overlay, "breadboard:\n  baseUrl: http://127.0.0.1:9099\n");
			const message = formatBridgeRefusal("breadboard.baseUrl", "http://127.0.0.1:9099");
			const runs = await Promise.all([
				runBb(["models", "--config", overlay], root),
				runBb([`--config=${overlay}`, "config", "list"], root),
				runBb(["--config", overlay, "-p", "hi"], root),
			]);
			for (const run of runs) {
				expect(run.exitCode).toBe(2);
				expect(run.stderr.trim()).toBe(message);
				expect(run.stdout).toBe("");
			}
			expect(fs.existsSync(path.join(root, "agent", "agent.db"))).toBe(false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("the global config requesting a bridge mode stops a subcommand; native mode does not", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bb-settings-refusal-"));
		try {
			fs.mkdirSync(path.join(root, "agent"), { recursive: true });
			const config = path.join(root, "agent", "config.yml");
			fs.writeFileSync(config, "breadboard:\n  engineMode: local-owned\n");
			const refused = await runBb(["models"], root);
			expect(refused.exitCode).toBe(2);
			expect(refused.stderr.trim()).toBe(formatBridgeRefusal("breadboard.engineMode", "local-owned"));
			expect(fs.existsSync(path.join(root, "agent", "agent.db"))).toBe(false);

			fs.writeFileSync(config, "breadboard:\n  engineMode: native\n");
			const accepted = await runBb(["models", "--help"], root);
			expect(accepted.exitCode).toBe(0);
			expect(accepted.stderr).not.toContain("bridge was removed");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
