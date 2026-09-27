import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BREADBOARD_DISTRIBUTION_POLICY } from "../src/product-distribution";

const fixtureDir = path.join(import.meta.dir, "fixtures");
const fixedNow = "2026-01-02T03:04:05.006Z";
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

test("the product logger writes where it advertises, under the product name", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "bb-product-logger-"));
	roots.push(root);
	const configDir = path.join(root, "config");
	const resultPath = path.join(root, "result.json");
	await fs.mkdir(configDir);
	const proc = Bun.spawn(
		[
			process.execPath,
			"--preload",
			path.join(fixtureDir, "logger-fixed-date-preload.ts"),
			path.join(fixtureDir, "product-logger-probe.ts"),
			resultPath,
		],
		{
			cwd: path.resolve(import.meta.dir, "../../.."),
			env: {
				...process.env,
				HOME: root,
				USERPROFILE: root,
				BREADBOARD_PRODUCT: "1",
				BREADBOARD_CONFIG_DIR: configDir,
				OMP_PROFILE: "",
				PI_PROFILE: "",
				XDG_DATA_HOME: "",
				XDG_STATE_HOME: "",
				XDG_CACHE_HOME: "",
				BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
				OMP_LOGGER_TEST_NOW: fixedNow,
				TZ: "Etc/GMT+5",
			},
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	expect(exitCode, stderr).toBe(0);

	const { advertisedPath } = JSON.parse(await fs.readFile(resultPath, "utf8")) as { advertisedPath: string };
	const productName = BREADBOARD_DISTRIBUTION_POLICY.productName;
	// fixedNow is 2026-01-01 in Etc/GMT+5.
	expect(advertisedPath).toBe(path.join(configDir, "logs", `${productName}.2026-01-01.${proc.pid}.log`));
	const records = (await fs.readFile(advertisedPath, "utf8"))
		.trim()
		.split(os.EOL)
		.map(line => JSON.parse(line) as { level: string; message: string; pid: number });
	expect(records).toContainEqual(expect.objectContaining({ level: "info", message: "mode-product", pid: proc.pid }));

	const auditPath = path.join(configDir, "logs", `.${productName}.${proc.pid}-audit.json`);
	const audit = JSON.parse(await fs.readFile(auditPath, "utf8")) as { auditLog: string };
	expect(audit.auditLog).toBe(auditPath);
});
