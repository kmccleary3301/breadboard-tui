#!/usr/bin/env bun

// Product identity belongs to the selected entrypoint, not the inherited
// process environment. A native OMP launched from a BreadBoard shell must not
// reuse BreadBoard's namespace, branding, or version identity.
delete process.env.BREADBOARD_PRODUCT;

const isCompiled = process.env.PI_COMPILED === "true";

async function main(): Promise<void> {
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
