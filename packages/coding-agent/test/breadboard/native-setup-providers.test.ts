import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

type RunInteractiveMode = NonNullable<Parameters<typeof runRootCommand>[2]>["runInteractiveMode"];

// `bb setup` in native mode has no engine runtime; the store setup and /login
// sign in to must come from the shared vault (BREADBOARD_OMP_AGENT_DIR).
describe("native setup credential store", () => {
	let originalVault: string | undefined;
	let originalIsTTY: boolean | undefined;

	beforeEach(() => {
		originalVault = process.env.BREADBOARD_OMP_AGENT_DIR;
		originalIsTTY = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	});

	afterEach(() => {
		if (originalVault === undefined) delete process.env.BREADBOARD_OMP_AGENT_DIR;
		else process.env.BREADBOARD_OMP_AGENT_DIR = originalVault;
		Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
	});

	async function launchSetup(discover: (agentDir: string | undefined) => Promise<AuthStorage>) {
		const rawArgs = ["--no-session", "--no-extensions", "--no-skills", "--no-rules", "--no-tools", "--no-lsp"];
		let args: Parameters<NonNullable<RunInteractiveMode>> | undefined;
		await runRootCommand(parseArgs(rawArgs), rawArgs, {
			settings: Settings.isolated(),
			forceSetupWizard: true,
			discoverAuthStorage: discover,
			runInteractiveMode: async (...received) => {
				args = received;
			},
		});
		if (!args) throw new Error("interactive mode was not started");
		return { breadboard: args[19], nativeVaultAuthStorage: args[21] };
	}

	it("hands the shared vault store to setup and /login", async () => {
		using tempDir = TempDir.createSync("@bb-native-setup-vault-");
		const vaultDir = fs.realpathSync(tempDir.path());
		process.env.BREADBOARD_OMP_AGENT_DIR = vaultDir;
		const vault = await AuthStorage.create(path.join(vaultDir, "agent.db"));
		const launched = await launchSetup(async agentDir =>
			agentDir === vaultDir ? vault : AuthStorage.create(path.join(vaultDir, "private.db")),
		);
		expect(launched.breadboard).toBeUndefined();
		expect(launched.nativeVaultAuthStorage).toBe(vault);
	});

	it("offers no sign-in store without a shared vault", async () => {
		delete process.env.BREADBOARD_OMP_AGENT_DIR;
		using tempDir = TempDir.createSync("@bb-native-setup-novault-");
		const privateStore = await AuthStorage.create(path.join(tempDir.path(), "agent.db"));
		const launched = await launchSetup(async () => privateStore);
		expect(launched.nativeVaultAuthStorage).toBeUndefined();
	});
});
