import { describe, expect, it } from "bun:test";

interface TaskDefaultsProbe {
	defaults: {
		maxConcurrency: number;
		maxRecursionDepth: number;
		maxRuntimeMs: number;
	};
	overrides: {
		maxConcurrency: number;
		maxRecursionDepth: number;
		maxRuntimeMs: number;
	};
}

const settingsUrl = new URL("../../src/config/settings.ts", import.meta.url).href;
const productSettingsUrl = new URL("../../src/breadboard/product-settings.ts", import.meta.url).href;

async function probeTaskDefaults(breadboardProduct: boolean): Promise<TaskDefaultsProbe> {
	const script = `
if (${breadboardProduct}) {
	const { activateBreadboardProduct } = await import(${JSON.stringify(productSettingsUrl)});
	await activateBreadboardProduct();
}
const { Settings } = await import(${JSON.stringify(settingsUrl)});

const defaults = Settings.isolated();
const overrides = Settings.isolated({
	"task.maxConcurrency": 9,
	"task.maxRecursionDepth": 3,
	"task.maxRuntimeMs": 0,
});
console.log(JSON.stringify({
	defaults: {
		maxConcurrency: defaults.get("task.maxConcurrency"),
		maxRecursionDepth: defaults.get("task.maxRecursionDepth"),
		maxRuntimeMs: defaults.get("task.maxRuntimeMs"),
	},
	overrides: {
		maxConcurrency: overrides.get("task.maxConcurrency"),
		maxRecursionDepth: overrides.get("task.maxRecursionDepth"),
		maxRuntimeMs: overrides.get("task.maxRuntimeMs"),
	},
}));
`;
	const child = Bun.spawn([process.execPath, "--eval", script], {
		env: { ...process.env, BREADBOARD_PRODUCT: breadboardProduct ? "1" : "0" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`task-default probe failed: exitCode=${exitCode}, stderr=${stderr}`);
	}
	return JSON.parse(stdout) as TaskDefaultsProbe;
}
async function probeProductSettingsImport(): Promise<{
	product: string | null;
	maxConcurrency: number;
}> {
	const script = `
await import(${JSON.stringify(productSettingsUrl)});
const { Settings } = await import(${JSON.stringify(settingsUrl)});
console.log(JSON.stringify({
	product: process.env.BREADBOARD_PRODUCT ?? null,
	maxConcurrency: Settings.isolated().get("task.maxConcurrency"),
}));
`;
	const env = { ...process.env };
	delete env.BREADBOARD_PRODUCT;
	const child = Bun.spawn([process.execPath, "--eval", script], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`product-settings import probe failed: exitCode=${exitCode}, stderr=${stderr}`);
	}
	return JSON.parse(stdout) as {
		product: string | null;
		maxConcurrency: number;
	};
}

describe("product task safety defaults", () => {
	it("bounds unset BreadBoard fan-out while preserving OMP defaults and explicit overrides", async () => {
		const [breadboard, omp] = await Promise.all([probeTaskDefaults(true), probeTaskDefaults(false)]);

		expect(breadboard.defaults).toEqual({
			maxConcurrency: 4,
			maxRecursionDepth: 1,
			maxRuntimeMs: 30 * 60_000,
		});
		expect(omp.defaults).toEqual({
			maxConcurrency: 32,
			maxRecursionDepth: 2,
			maxRuntimeMs: 0,
		});
		expect(breadboard.overrides).toEqual({
			maxConcurrency: 9,
			maxRecursionDepth: 3,
			maxRuntimeMs: 0,
		});
		expect(omp.overrides).toEqual(breadboard.overrides);
	}, 15_000);

	it("does not mutate product identity or defaults when imported", async () => {
		expect(await probeProductSettingsImport()).toEqual({
			product: null,
			maxConcurrency: 32,
		});
	});
});
