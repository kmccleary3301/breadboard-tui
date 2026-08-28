#!/usr/bin/env bun

// Product identity belongs to the selected entrypoint, not later environment
// loads. Pin the negative marker so profile .env files and descendants cannot
// promote native OMP into BreadBoard's namespace, branding, or version.
process.env.BREADBOARD_PRODUCT = "0";

const isCompiled = process.env.PI_COMPILED === "true";

async function main(): Promise<void> {
	const { runCli } = await import("./cli");
	// A compiled CLI module self-dispatches from its process entry. Source
	// execution imports cli.ts as a module, so the wrapper owns invocation there.
	if (!isCompiled && Bun.isMainThread) await runCli(process.argv.slice(2), { processEntry: true });
}

if (import.meta.main || isCompiled || !Bun.isMainThread) {
	try {
		await main();
	} catch (error) {
		process.stderr.write(`${Bun.inspect(error, { colors: process.stderr.isTTY === true })}\n`);
		process.exit(1);
	}
}
