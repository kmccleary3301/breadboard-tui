import { describe, expect, test } from "bun:test";
import type { InstalledEngineSelection } from "./installed-engine-selection";
import { resolveProductBreadboardRunConfig } from "./product-run-config";
import { BreadboardRunConfigError, type EngineArtifact } from "./run-config";

const artifact: EngineArtifact = {
	kind: "direct-executable",
	executablePath: "/usr/bin/false",
	argv: ["--serve"],
	argvSha256: "sha256:b76470afe32d50ae8194866d39a872e4dc846e89ac409f390884db522242a6b4",
	executableSha256: `sha256:${"b".repeat(64)}`,
	engineSourceSha256: `sha256:${"c".repeat(64)}`,
	servedBackendCommit: "d".repeat(40),
};
const installedSelection = {
	artifact,
	manifest: {},
	manifestPath: "/Applications/BreadBoard.app/Contents/MacOS/engine/breadboard-engine-manifest.v1.json",
} as unknown as InstalledEngineSelection;
const baseInput = {
	workspacePath: "/workspace",
	canonicalizeWorkspace: () => "/canonical/workspace",
	environment: {} as Record<string, string | undefined>,
};

function environmentArtifact(): Record<string, string> {
	return {
		BREADBOARD_ENGINE_EXECUTABLE: artifact.executablePath,
		BREADBOARD_ENGINE_ARGV_JSON: JSON.stringify(artifact.argv),
		BREADBOARD_ENGINE_EXECUTABLE_SHA256: artifact.executableSha256,
		BREADBOARD_ENGINE_SOURCE_SHA256: artifact.engineSourceSha256,
		BREADBOARD_ENGINE_BACKEND_COMMIT: artifact.servedBackendCommit,
	};
}

describe("resolveProductBreadboardRunConfig", () => {
	test("selects the installed artifact and product endpoint only for a product-owned default", async () => {
		let calls = 0;
		const environment = {} as Record<string, string | undefined>;
		const config = await resolveProductBreadboardRunConfig({
			...baseInput,
			environment,
			isBreadboardProduct: true,
			productExecutablePath: "/Applications/BreadBoard.app/Contents/MacOS/bb",
			resolveInstalledSelection: async input => {
				calls++;
				expect(input.productExecutablePath).toEndWith("/bb");
				return installedSelection;
			},
		});

		expect(calls).toBe(1);
		expect(environment.BREADBOARD_PRODUCT).toBeUndefined();
		expect(config).toMatchObject({
			mode: "local-owned",
			endpoint: "http://127.0.0.1:9099",
			sources: { endpoint: "derived-default", engineArtifact: "derived-installed-artifact" },
		});
	});

	test("preserves CLI, environment, and selected artifact precedence without discovery", async () => {
		let calls = 0;
		const resolveInstalledSelection = async () => {
			calls++;
			return installedSelection;
		};
		const fromEnvironment = await resolveProductBreadboardRunConfig({
			...baseInput,
			environment: environmentArtifact(),
			isBreadboardProduct: true,
			selectedConfig: { engineArtifact: { ...artifact, servedBackendCommit: "e".repeat(40) } },
			resolveInstalledSelection,
		});
		expect(fromEnvironment.sources.engineArtifact).toBe("environment");
		const fromSelected = await resolveProductBreadboardRunConfig({
			...baseInput,
			isBreadboardProduct: true,
			selectedConfig: { engineArtifact: artifact },
			resolveInstalledSelection,
		});
		expect(fromSelected.sources.engineArtifact).toBe("selected-config");
		expect(calls).toBe(0);
	});

	test("does not discover for off, remote, local-external, or an explicit invalid artifact", async () => {
		let calls = 0;
		const resolveInstalledSelection = async () => {
			calls++;
			return installedSelection;
		};
		const cases = [
			{ cli: { engineMode: "off" } },
			{ cli: { engineMode: "local-external", engineUrl: "http://127.0.0.1:8080" } },
			{
				cli: { engineMode: "remote", engineUrl: "https://engine.example" },
				environment: { BREADBOARD_API_TOKEN: "synthetic-secret" },
			},
		] as const;
		for (const item of cases) {
			await resolveProductBreadboardRunConfig({
				...baseInput,
				...item,
				isBreadboardProduct: true,
				resolveInstalledSelection,
			});
		}
		const invalid = await resolveProductBreadboardRunConfig({
			...baseInput,
			isBreadboardProduct: true,
			selectedConfig: { engineArtifact: { kind: "direct-executable" } },
			resolveInstalledSelection,
		}).catch(error => error);
		expect(invalid).toMatchObject({ code: "invalid_artifact" });
		expect(calls).toBe(0);
	});

	test("rethrows explicit local-owned missing artifact without discovery", async () => {
		let calls = 0;
		const error = await resolveProductBreadboardRunConfig({
			...baseInput,
			cli: { engineMode: "local-owned" },
			isBreadboardProduct: true,
			resolveInstalledSelection: async () => {
				calls++;
				return installedSelection;
			},
		}).catch(error => error);
		expect(error).toMatchObject({ code: "missing_engine_artifact", field: "engineArtifact" });
		expect(calls).toBe(0);

		const native = await resolveProductBreadboardRunConfig({
			...baseInput,
			cli: { engineMode: "off" },
			isBreadboardProduct: false,
			resolveInstalledSelection: async () => {
				calls++;
				return installedSelection;
			},
		});
		expect(native.mode).toBe("off");
		expect(calls).toBe(0);
	});
	test("covers product/native identity, precedence, inferred endpoints, and fail-closed errors", async () => {
		const cases = [
			{
				name: "product all-default",
				product: true,
				input: {},
				expected: {
					result: {
						mode: "local-owned",
						endpoint: "http://127.0.0.1:9099",
						sources: { engineArtifact: "derived-installed-artifact" },
					},
					calls: 1,
				},
			},
			{
				name: "native explicit off",
				product: false,
				input: { cli: { engineMode: "off" } },
				expected: {
					result: { mode: "off", sources: { mode: "cli", engineArtifact: "derived-default" } },
					calls: 0,
				},
			},
			{
				name: "explicit local-owned without artifact",
				product: true,
				input: { cli: { engineMode: "local-owned" } },
				expected: { error: "missing_engine_artifact", calls: 0 },
			},
			{
				name: "explicit local-external",
				product: true,
				input: { cli: { engineMode: "local-external", engineUrl: "http://127.0.0.1:8080" } },
				expected: {
					result: {
						mode: "local-external",
						endpoint: "http://127.0.0.1:8080",
						sources: { mode: "cli", endpoint: "cli" },
					},
					calls: 0,
				},
			},
			{
				name: "explicit remote",
				product: true,
				input: {
					cli: { engineMode: "remote", engineUrl: "https://engine.example" },
					environment: { BREADBOARD_API_TOKEN: "synthetic-process-secret" },
				},
				expected: {
					result: { mode: "remote", sources: { mode: "cli", endpoint: "cli", auth: "environment" } },
					calls: 0,
				},
			},
			{
				name: "selected off",
				product: true,
				input: { selectedConfig: { engineMode: "off" } },
				expected: { result: { mode: "off", sources: { mode: "selected-config" } }, calls: 0 },
			},
			{
				name: "environment and CLI mode precedence",
				product: true,
				input: {
					cli: { engineMode: "off" },
					environment: { BREADBOARD_ENGINE_MODE: "remote" },
					selectedConfig: { engineMode: "local-external" },
				},
				expected: { result: { mode: "off", sources: { mode: "cli" } }, calls: 0 },
			},
			{
				name: "environment mode beats selected mode",
				product: true,
				input: { environment: { BREADBOARD_ENGINE_MODE: "off" }, selectedConfig: { engineMode: "remote" } },
				expected: { result: { mode: "off", sources: { mode: "environment" } }, calls: 0 },
			},
			{
				name: "CLI endpoint beats environment and selected endpoint",
				product: true,
				input: {
					cli: { engineUrl: "http://127.0.0.1:8083" },
					environment: { BREADBOARD_API_URL: "http://127.0.0.1:8082" },
					selectedConfig: { baseUrl: "http://127.0.0.1:8081" },
				},
				expected: {
					result: { mode: "local-external", endpoint: "http://127.0.0.1:8083", sources: { endpoint: "cli" } },
					calls: 0,
				},
			},
			{
				name: "inferred endpoints",
				product: true,
				input: {
					environment: {
						BREADBOARD_API_URL: "https://engine.example",
						BREADBOARD_API_TOKEN: "synthetic-process-secret",
					},
				},
				expected: {
					result: { mode: "remote", sources: { mode: "derived-default", endpoint: "environment" } },
					calls: 0,
				},
			},
			{
				name: "selected loopback endpoint",
				product: true,
				input: { selectedConfig: { baseUrl: "http://127.0.0.1:8081" } },
				expected: {
					result: {
						mode: "local-external",
						endpoint: "http://127.0.0.1:8081",
						sources: { mode: "derived-default", endpoint: "selected-config" },
					},
					calls: 0,
				},
			},
			{
				name: "valid selected/environment artifacts",
				product: true,
				input: { selectedConfig: { engineArtifact: artifact } },
				expected: { result: { mode: "local-owned", sources: { engineArtifact: "selected-config" } }, calls: 0 },
			},
			{
				name: "valid environment artifact",
				product: true,
				input: { environment: environmentArtifact() },
				expected: { result: { mode: "local-owned", sources: { engineArtifact: "environment" } }, calls: 0 },
			},
			{
				name: "invalid and partial artifacts",
				product: true,
				input: { environment: { BREADBOARD_ENGINE_EXECUTABLE: artifact.executablePath } },
				expected: { error: "invalid_artifact", calls: 0 },
			},
			{
				name: "invalid selected artifact",
				product: true,
				input: { selectedConfig: { engineArtifact: { kind: "direct-executable" } } },
				expected: { error: "invalid_artifact", calls: 0 },
			},
			{
				name: "explicit remote TLS and auth",
				product: true,
				input: {
					cli: { engineMode: "remote", engineUrl: "https://engine.example" },
					selectedConfig: {
						auth: { kind: "keychain-reference", reference: "test-token" },
						tls: { kind: "system-trust" },
					},
				},
				expected: {
					result: { mode: "remote", sources: { auth: "selected-config", tls: "selected-config" } },
					calls: 0,
				},
			},
			{
				name: "remote auth/TLS/security failures",
				product: true,
				input: {
					cli: { engineMode: "remote", engineUrl: "https://engine.example" },
					environment: { BREADBOARD_API_TOKEN: "short" },
				},
				expected: { error: "invalid_auth", calls: 0 },
			},
			{
				name: "remote TLS failure",
				product: true,
				input: {
					cli: { engineMode: "remote", engineUrl: "https://engine.example" },
					environment: { BREADBOARD_API_TOKEN: "synthetic-process-secret" },
					selectedConfig: { tls: { kind: "system-trust", spkiPin: "invalid" } },
				},
				expected: { error: "invalid_tls", calls: 0 },
			},
			{
				name: "remote non-HTTPS failure",
				product: true,
				input: {
					cli: { engineMode: "remote", engineUrl: "http://engine.example" },
					environment: { BREADBOARD_API_TOKEN: "synthetic-process-secret" },
				},
				expected: { error: "mode_endpoint_conflict", calls: 0 },
			},
			{
				name: "non-selector fields still discover",
				product: true,
				input: {
					selectedConfig: {
						startupTimeoutMs: 5_000,
						requestTimeoutMs: 6_000,
						ownerExitPolicy: "detached",
						workspaceId: `workspace:v1:sha256:${"a".repeat(64)}`,
						sessionConfigPath: "/tmp/session.json",
					},
				},
				expected: {
					result: {
						mode: "local-owned",
						sources: {
							engineArtifact: "derived-installed-artifact",
							startupTimeoutMs: "selected-config",
							requestTimeoutMs: "selected-config",
							ownerExitPolicy: "selected-config",
							workspaceId: "selected-config",
							sessionConfigPath: "selected-config",
						},
					},
					calls: 1,
				},
			},
		] as const;

		for (const item of cases) {
			let calls = 0;
			const result = await resolveProductBreadboardRunConfig({
				...baseInput,
				...item.input,
				isBreadboardProduct: item.product,
				resolveInstalledSelection: async () => {
					calls++;
					return installedSelection;
				},
			}).catch(error => error);
			expect(calls).toBe(item.expected.calls);
			if ("error" in item.expected) {
				expect(result).toBeInstanceOf(BreadboardRunConfigError);
				expect(result).toMatchObject({ code: item.expected.error });
			} else {
				expect(result).toMatchObject(item.expected.result);
			}
		}
	});
});
