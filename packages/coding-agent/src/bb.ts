#!/usr/bin/env bun

import { activateBreadboardProduct } from "./breadboard/product-settings";

const isCompiled = process.env.PI_COMPILED === "true";

async function main(): Promise<void> {
	await activateBreadboardProduct();
	const { runCli } = await import("./cli");
	// A compiled CLI module self-dispatches from its process entry. Source
	// execution imports cli.ts as a module, so the wrapper owns invocation there.
	if (!isCompiled && Bun.isMainThread) await runCli(process.argv.slice(2), { processEntry: true });
}

if (import.meta.main || isCompiled || !Bun.isMainThread) {
	main().catch((error: unknown) => {
		process.stderr.write(`${Bun.inspect(error, { colors: process.stderr.isTTY === true })}\n`);
		process.exit(1);
	});
}
