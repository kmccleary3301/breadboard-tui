#!/usr/bin/env bun

// This assignment must happen before importing the shared CLI: dirs.ts and env.ts
// cache product-sensitive paths during module initialization.
process.env.BREADBOARD_PRODUCT = "1";

const isCompiled = process.env.PI_COMPILED === "true";

async function main(): Promise<void> {
	const { installBreadboardSettingDefaults } = await import("./breadboard/product-settings");
	installBreadboardSettingDefaults();
	const { runCli } = await import("./cli");
	// A compiled CLI module self-dispatches from its process entry. Source
	// execution imports cli.ts as a module, so the wrapper owns invocation there.
	if (!isCompiled && Bun.isMainThread) await runCli(process.argv.slice(2));
}

if (import.meta.main || isCompiled || !Bun.isMainThread) {
	main().catch((error: unknown) => {
		process.stderr.write(`${Bun.inspect(error, { colors: process.stderr.isTTY === true })}\n`);
		process.exit(1);
	});
}
