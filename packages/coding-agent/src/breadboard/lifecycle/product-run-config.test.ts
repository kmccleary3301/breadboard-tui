import { describe, expect, test } from "bun:test";
import type { InstalledEngineSelection } from "./installed-engine-selection";
import { resolveProductBreadboardRunConfig } from "./product-run-config";
import type { EngineArtifact } from "./run-config";

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

	test("allows installed fallback for explicit local-owned but never for native off mode", async () => {
		let calls = 0;
		const resolveInstalledSelection = async () => {
			calls++;
			return installedSelection;
		};
		const localOwned = await resolveProductBreadboardRunConfig({
			...baseInput,
			cli: { engineMode: "local-owned" },
			isBreadboardProduct: true,
			resolveInstalledSelection,
		});
		expect(localOwned.sources.engineArtifact).toBe("derived-installed-artifact");
		const native = await resolveProductBreadboardRunConfig({
			...baseInput,
			cli: { engineMode: "off" },
			isBreadboardProduct: false,
			resolveInstalledSelection,
		});
		expect(native.mode).toBe("off");
		expect(calls).toBe(1);
	});
});
