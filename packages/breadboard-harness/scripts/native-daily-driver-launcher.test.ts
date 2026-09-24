import { chmod, mkdir, mkdtemp, readdir, realpath, writeFile } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { renderNativeDailyDriverLauncher } from "./native-daily-driver-launcher";

interface LauncherFixture {
	root: string;
	workspace: string;
	launcher: string;
	nativeProfile: string;
	countFile: string;
}

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => Bun.$`rm -rf ${root}`));
});

async function workspaceKey(workspace: string): Promise<string> {
	return new Bun.CryptoHasher("sha256").update(workspace).digest("hex");
}

async function setupLauncher(withR39Profile = true): Promise<LauncherFixture> {
	const root = await mkdtemp(join(tmpdir(), "bb-native-launcher-test-"));
	temporaryRoots.push(root);
	let workspace = join(root, "workspace");
	const r39ProfileRoot = join(root, "r39", "user", "projects");
	const nativeProfileRoot = join(root, "native");
	const authSource = join(root, "auth");
	await mkdir(join(workspace, ".git"), { recursive: true });
	workspace = await realpath(workspace);
	const sourceProfile = join(r39ProfileRoot, await workspaceKey(workspace));
	if (withR39Profile) {
		await mkdir(join(sourceProfile, "agent"), { recursive: true });
		await writeFile(
			join(sourceProfile, "agent", "config.yml"),
			"breadboard:\n  engineMode: local-owned\n  harness:\n    default: .breadboard/bb-omp/r39/bb-omp.harness.yaml\n",
		);
		await writeFile(join(sourceProfile, "agent", "agent.db"), "credentials");
		await writeFile(join(sourceProfile, "agent", "agent.db-wal"), "credential sidecar");
	}
	await mkdir(authSource, { recursive: true });
	await writeFile(join(authSource, "agent.db"), "vault");
	const fakeBinary = join(root, "fake-bb");
	const countFile = join(root, "count");
	const fakeScript = [
		"#!/bin/bash",
		'if [[ "${1:-}" == "--version" ]]; then exit 0; fi',
		'if [[ -n "${BREADBOARD_NATIVE_PROFILE_MIGRATION_RECEIPT:-}" ]]; then',
		`  printf '{"schema":"test"}\\n' > "$BREADBOARD_NATIVE_PROFILE_MIGRATION_RECEIPT"`,
		"fi",
		`count_file='${countFile}'`,
		"count=0",
		'[[ -f "$count_file" ]] && count="$(cat "$count_file")"',
		"count=$((count + 1))",
		"printf '%s' \"$count\" > \"$count_file\"",
		'if [[ "$count" == 1 && -n "${BREADBOARD_NATIVE_PROFILE_MIGRATION:-}" ]]; then exit 1; fi',
	].join("\n");
	const launcher = join(root, "candidate");
	await writeFile(fakeBinary, `${fakeScript}\n`);
	await chmod(fakeBinary, 0o700);
	await writeFile(
		launcher,
		renderNativeDailyDriverLauncher({
			binaryPath: fakeBinary,
			nativeProfileRoot,
			r39ProfileRoot,
			authSource,
			freshProfileSettings: JSON.stringify({
				symbolPreset: "nerd",
				composer: { shape: "box" },
				theme: { dark: "titanium", light: "light" },
				tools: { approvalMode: "always-ask" },
				modelRoles: { default: "openai-codex/gpt-5.6-luna", tiny: "openai-codex/gpt-5.6-luna" },
				breadboard: { harness: { default: "daily_driver" } },
			}),
		}),
	);
	await chmod(launcher, 0o700);
	return {
		root,
		workspace,
		launcher,
		nativeProfile: join(nativeProfileRoot, "user", "projects", await workspaceKey(workspace)),
		countFile: join(root, "count"),
	};
}

function spawn(fixture: LauncherFixture, args: string[] = []) {
	return Bun.spawnSync([fixture.launcher, ...args], {
		cwd: fixture.workspace,
		env: { ...process.env, HOME: fixture.root, FAKE_COUNT_FILE: fixture.countFile },
	});
}

describe("native daily-driver launcher", () => {
	test("removes stale seed directories while seeding an existing R39 profile", async () => {
		const fixture = await setupLauncher();
		const staleSeed = `${fixture.nativeProfile}.seed.crash`;
		await mkdir(join(staleSeed, "agent"), { recursive: true });
		await writeFile(join(staleSeed, "agent", "partial"), "partial");
		const first = spawn(fixture);
		expect(first.exitCode).toBe(1);
		expect((await readdir(dirname(fixture.nativeProfile))).filter(name => name.includes(".seed."))).toEqual([]);
		expect(await Bun.file(join(fixture.nativeProfile, ".bb-native-profile-migration.v1.json")).exists()).toBe(false);
		expect(lstatSync(join(fixture.nativeProfile, "agent", "agent.db")).isSymbolicLink()).toBe(true);
		const databaseFiles = (await readdir(join(fixture.nativeProfile, "agent"))).filter(name => name.startsWith("agent.db"));
		expect(databaseFiles).toEqual(["agent.db"]);
	});

	test("does not create a profile for metadata commands in an empty workspace", async () => {
		const fixture = await setupLauncher(false);
		const version = spawn(fixture, ["--version"]);
		expect(version.exitCode).toBe(0);
		expect(await Bun.file(fixture.nativeProfile).exists()).toBe(false);
	});

	test("seeds a fresh workspace without an R39 profile", async () => {
		const fixture = await setupLauncher(false);
		const result = spawn(fixture);
		expect(result.exitCode).toBe(0);
		const config = await Bun.file(join(fixture.nativeProfile, "agent", "config.yml")).text();
		expect(config).toContain('"symbolPreset":"nerd"');
		expect(config).toContain('"default":"daily_driver"');
		expect(await Bun.file(join(fixture.nativeProfile, ".bb-native-profile-migration.v1.json")).exists()).toBe(true);
		expect(await Bun.file(join(fixture.nativeProfile, ".bb-native-profile-migration.receipt.v1.json")).exists()).toBe(true);
	});

	test("retries migration after a failed launch and truncated marker", async () => {
		const fixture = await setupLauncher();
		const marker = join(fixture.nativeProfile, ".bb-native-profile-migration.v1.json");
		const first = spawn(fixture);
		expect(first.exitCode).toBe(1);
		expect(await Bun.file(marker).exists()).toBe(false);
		await writeFile(marker, "{");
		const second = spawn(fixture);
		expect(second.exitCode).toBe(0);
		expect(await Bun.file(marker).text()).toContain('"schema":"bb.native_profile_migration.v1"');
	});
});
