import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const packageDir = path.resolve(import.meta.dir, "..");
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

interface ProcessResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

async function runProcess(
	args: readonly string[],
	home: string,
	overrides: Record<string, string> = {},
): Promise<ProcessResult> {
	const env: Record<string, string | undefined> = {
		...Bun.env,
		HOME: home,
		XDG_CONFIG_HOME: path.join(home, "xdg-config"),
		XDG_DATA_HOME: path.join(home, "xdg-data"),
		XDG_STATE_HOME: path.join(home, "xdg-state"),
		XDG_CACHE_HOME: path.join(home, "xdg-cache"),
	};
	delete env.BREADBOARD_PRODUCT;
	delete env.PI_CONFIG_DIR;
	delete env.PI_CODING_AGENT_DIR;
	Object.assign(env, overrides);
	const child = Bun.spawn([process.execPath, ...args], {
		cwd: packageDir,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function temporaryHome(): Promise<string> {
	const home = await mkdtemp(path.join(os.tmpdir(), "bb-product-home-"));
	roots.push(home);
	return home;
}

describe("BreadBoard product entrypoint", () => {
	test("reports the BreadBoard product lineage", async () => {
		const result = await runProcess(["src/bb.ts", "--version"], await temporaryHome());

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("bb/0.1.0-rc.1 omp/17.4.0 sdk/0.3.0 engine-api >=0.1.0 <0.4.0");
	});

	test("uses the bb identity and never touches a native ~/.omp tree", async () => {
		const home = await temporaryHome();
		const nativeRoot = path.join(home, ".omp");
		await mkdir(nativeRoot, { recursive: true });
		const sentinel = path.join(nativeRoot, "sentinel");
		await writeFile(sentinel, "native-only\n");

		const result = await runProcess(["src/bb.ts", "--help"], home);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("bb v0.1.0-rc.1");
		expect(result.stdout).toContain("~/.breadboard/agent");
		expect(await readFile(sentinel, "utf8")).toBe("native-only\n");
		expect(await Bun.file(path.join(home, ".breadboard")).exists()).toBe(false);
	});
	test("keeps the native omp identity and namespace available", async () => {
		const home = await temporaryHome();
		const result = await runProcess(["src/cli.ts", "--version"], home);

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("omp/17.4.0");
		expect(await Bun.file(path.join(home, ".breadboard")).exists()).toBe(false);
	});

	test("bootstraps explicit BreadBoard config and agent path overrides", async () => {
		const home = await temporaryHome();
		const configRoot = path.join(home, "custom-config");
		const agentRoot = path.join(home, "custom-agent");
		const modulePath = path.join(packageDir, "..", "utils", "src", "dirs.ts");
		const probe =
			"const dirs = await import(process.env.BB_DIRS_MODULE); process.stdout.write(JSON.stringify({ root: dirs.getConfigRootDir(), agent: dirs.getAgentDir() }));";
		const result = await runProcess(["-e", probe], home, {
			BREADBOARD_PRODUCT: "1",
			BREADBOARD_CONFIG_DIR: configRoot,
			PI_CODING_AGENT_DIR: agentRoot,
			BB_DIRS_MODULE: modulePath,
		});

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ root: configRoot, agent: agentRoot });
	});

	test("isolates BreadBoard project settings from native .omp config", async () => {
		const home = await temporaryHome();
		const projectRoot = path.join(home, "project");
		const agentRoot = path.join(home, ".breadboard", "agent");
		await mkdir(path.join(projectRoot, ".omp"), { recursive: true });
		await mkdir(path.join(projectRoot, ".breadboard"), { recursive: true });
		await mkdir(agentRoot, { recursive: true });
		await writeFile(path.join(projectRoot, ".omp", "config.yml"), "modelRoles:\n  default: native/omp-only\n");
		await writeFile(
			path.join(projectRoot, ".breadboard", "config.yml"),
			"modelRoles:\n  default: breadboard/product\n",
		);

		const probe =
			'const { Settings } = await import("./src/config/settings.ts"); const settings = await Settings.loadReadOnly({ cwd: process.env.BB_PROJECT, agentDir: process.env.BB_AGENT }); process.stdout.write(String(settings.get("modelRoles").default));';
		const result = await runProcess(["-e", probe], home, {
			BREADBOARD_PRODUCT: "1",
			BB_PROJECT: projectRoot,
			BB_AGENT: agentRoot,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("breadboard/product");
	});
});
