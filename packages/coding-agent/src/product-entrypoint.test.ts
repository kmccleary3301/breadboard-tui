import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

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
	delete env.BREADBOARD_CONFIG_DIR;
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
		expect(result.stdout.trim()).toBe("bb/0.1.0-rc.4 omp/18.0.1 sdk/0.3.0 engine-api >=0.1.0 <0.4.0");
	});

	test("uses the bb identity and never touches a native ~/.omp tree", async () => {
		const home = await temporaryHome();
		const nativeRoot = path.join(home, ".omp");
		await mkdir(nativeRoot, { recursive: true });
		const sentinel = path.join(nativeRoot, "sentinel");
		await writeFile(sentinel, "native-only\n");

		const result = await runProcess(["src/bb.ts", "--help"], home);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("bb v0.1.0-rc.4");
		expect(result.stdout).toContain("~/.breadboard/agent");
		expect(await readFile(sentinel, "utf8")).toBe("native-only\n");
		expect(await Bun.file(path.join(home, ".breadboard")).exists()).toBe(false);
	});
	test("keeps the native omp identity and namespace despite an inherited BreadBoard marker", async () => {
		const home = await temporaryHome();
		const result = await runProcess(["src/omp.ts", "--version"], home, { BREADBOARD_PRODUCT: "1" });

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("omp/18.0.1");
		expect(await Bun.file(path.join(home, ".breadboard")).exists()).toBe(false);
	});
	test("selects the active identity once in fresh product and native processes", async () => {
		const probe =
			'const identity = await import("./src/product-identity.ts"); process.stdout.write(JSON.stringify(identity.ACTIVE_PRODUCT_IDENTITY));';
		const [product, native] = await Promise.all([
			runProcess(["-e", probe], await temporaryHome(), { BREADBOARD_PRODUCT: "1" }),
			runProcess(["-e", probe], await temporaryHome()),
		]);

		expect(product).toMatchObject({ exitCode: 0, stderr: "" });
		expect(native).toMatchObject({ exitCode: 0, stderr: "" });
		expect(JSON.parse(product.stdout)).toMatchObject({
			id: "breadboard",
			displayName: "BreadBoard",
			cliName: "bb",
		});
		expect(JSON.parse(native.stdout)).toMatchObject({
			id: "omp",
			displayName: "Oh My Pi",
			cliName: "omp",
		});
	});

	test("ignores BreadBoard config overrides in the native entrypoint", async () => {
		const home = await temporaryHome();
		const nativeConfigDir = "native-config";
		const productRoot = path.join(home, "product-config");
		const dirsModule = path.join(packageDir, "..", "utils", "src", "dirs.ts");
		const probe =
			'await import("./src/omp.ts"); const dirs = await import(process.env.BB_DIRS_MODULE); process.stdout.write(JSON.stringify({ product: dirs.IS_BREADBOARD_PRODUCT, root: dirs.getConfigRootDir() }));';
		const result = await runProcess(["-e", probe], home, {
			BREADBOARD_PRODUCT: "1",
			BREADBOARD_CONFIG_DIR: productRoot,
			PI_CONFIG_DIR: nativeConfigDir,
			BB_DIRS_MODULE: dirsModule,
		});

		expect(result).toMatchObject({ exitCode: 0, stderr: "" });
		expect(JSON.parse(result.stdout)).toEqual({ product: false, root: path.join(home, nativeConfigDir) });
	});

	test("keeps native identity when the selected profile env reintroduces the product marker", async () => {
		const home = await temporaryHome();
		const agentDir = path.join(home, ".omp", "agent");
		const productRoot = path.join(home, "hostile-product-config");
		await mkdir(agentDir, { recursive: true });
		await writeFile(path.join(agentDir, ".env"), "BREADBOARD_PRODUCT=1\n");

		const result = await runProcess(["src/omp.ts", "--help"], home, {
			BREADBOARD_PRODUCT: "1",
			BREADBOARD_CONFIG_DIR: productRoot,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("omp v18.0.1");
		expect(result.stdout).toContain("~/.omp/agent");
		expect(result.stdout).toContain("--engine-mode");
		expect(result.stdout).toContain("--engine-url");
		expect(result.stdout).toContain("engine         Manage the governed BreadBoard engine lifecycle");
		expect(result.stdout).not.toContain("~/.breadboard");
		expect(await Bun.file(productRoot).exists()).toBe(false);
	});

	test("pins native identity across profile env and native-loader initialization", async () => {
		const home = await temporaryHome();
		const agentDir = path.join(home, ".omp", "agent");
		const productRoot = path.join(home, "hostile-product-config");
		const nativeLoaderModule = path.join(packageDir, "..", "natives", "native", "loader-state.js");
		await mkdir(agentDir, { recursive: true });
		await writeFile(path.join(agentDir, ".env"), "BREADBOARD_PRODUCT=1\n");
		const probe =
			'await import("./src/omp.ts"); await import("@oh-my-pi/pi-utils/env"); const dirs = await import("@oh-my-pi/pi-utils/dirs"); const loader = await import(process.env.BB_NATIVE_LOADER_MODULE); process.stdout.write(JSON.stringify({ marker: process.env.BREADBOARD_PRODUCT, root: dirs.getConfigRootDir(), natives: loader.resolveNativesDir({ homeDir: process.env.HOME, pathExists: () => false }) }));';

		const result = await runProcess(["-e", probe], home, {
			BREADBOARD_PRODUCT: "1",
			BREADBOARD_CONFIG_DIR: productRoot,
			BB_NATIVE_LOADER_MODULE: nativeLoaderModule,
		});

		expect(result).toMatchObject({ exitCode: 0, stderr: "" });
		expect(JSON.parse(result.stdout)).toEqual({
			marker: "0",
			root: path.join(home, ".omp"),
			natives: path.join(home, ".omp", "natives"),
		});
		expect(await Bun.file(productRoot).exists()).toBe(false);
	});

	test("renders BreadBoard welcome copy only in an isolated product process", async () => {
		const probe = String.raw`
			const { Settings } = await import("./src/config/settings.ts");
			const { initTheme } = await import("./src/modes/theme/theme.ts");
			await Settings.init({ inMemory: true });
			await initTheme(false);
			const { BREADBOARD_PRODUCT_IDENTITY, OMP_PRODUCT_IDENTITY } = await import("./src/product-identity.ts");
			const { WelcomeComponent } = await import("./src/modes/components/welcome.ts");
			const stripAnsi = value => value.replace(/\x1b\[[0-9;]*m/g, "");
			const hasRow = (lines, row) => lines.some(line => line.includes(row.trimEnd()));
			const welcome = new WelcomeComponent("0.1.0-rc.4", "model", "provider");
			const lines = welcome.render(90).map(stripAnsi);
			const widths = [20, 12, 6].map(width => {
				welcome.invalidate();
				return welcome.render(width).every(line => [...stripAnsi(line)].length <= width);
			});
			process.stdout.write(JSON.stringify({
				header: lines[0],
				breadboardLogo: BREADBOARD_PRODUCT_IDENTITY.logoArt.every(row => hasRow(lines, row)),
				ompLogo: hasRow(lines, OMP_PRODUCT_IDENTITY.logoArt[1]),
				widths,
			}));
		`;
		const result = await runProcess(["-e", probe], await temporaryHome(), { BREADBOARD_PRODUCT: "1" });

		expect(result).toMatchObject({ exitCode: 0, stderr: "" });
		expect(JSON.parse(result.stdout)).toEqual({
			header: expect.stringContaining("BreadBoard v0.1.0-rc.4"),
			breadboardLogo: true,
			ompLogo: false,
			widths: [true, true, true],
		});
	});

	test("keeps configured custom themes ahead of product defaults for both appearances", async () => {
		const probe = `
			const { mkdir } = await import("node:fs/promises");
			const path = await import("node:path");
			const { getCustomThemesDir } = await import("@oh-my-pi/pi-utils");
			const themesDir = getCustomThemesDir();
			await mkdir(themesDir, { recursive: true });
			const darkBase = await Bun.file("./src/modes/theme/dark.json").json();
			const lightBase = await Bun.file("./src/modes/theme/light.json").json();
			await Bun.write(path.join(themesDir, "identity-custom-dark.json"), JSON.stringify({ ...darkBase, name: "identity-custom-dark" }));
			await Bun.write(path.join(themesDir, "identity-custom-light.json"), JSON.stringify({ ...lightBase, name: "identity-custom-light" }));
			const { Settings } = await import("./src/config/settings.ts");
			const theme = await import("./src/modes/theme/theme.ts");
			await Settings.init({ inMemory: true });
			await theme.initTheme(false);
			const defaultTheme = theme.getCurrentThemeName();
			await theme.initTheme(false, undefined, undefined, "identity-custom-dark", "identity-custom-light");
			process.stdout.write(JSON.stringify({ defaultTheme, configuredTheme: theme.getCurrentThemeName() }));
		`;
		const [dark, light] = await Promise.all([
			runProcess(["-e", probe], await temporaryHome(), {
				BREADBOARD_PRODUCT: "1",
				COLORFGBG: "15;0",
			}),
			runProcess(["-e", probe], await temporaryHome(), {
				BREADBOARD_PRODUCT: "1",
				COLORFGBG: "0;15",
			}),
		]);

		expect(dark).toMatchObject({ exitCode: 0, stderr: "" });
		expect(light).toMatchObject({ exitCode: 0, stderr: "" });
		expect(JSON.parse(dark.stdout)).toEqual({
			defaultTheme: "breadboard",
			configuredTheme: "identity-custom-dark",
		});
		expect(JSON.parse(light.stdout)).toEqual({
			defaultTheme: "breadboard-light",
			configuredTheme: "identity-custom-light",
		});
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
