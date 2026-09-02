#!/usr/bin/env bun
import { parentPort } from "node:worker_threads";
import { installWorkerInbox, isWorkerHostSelector } from "@oh-my-pi/pi-utils/worker-host";

import { activateNativeProduct } from "./native-product-env";

const isCompiled = process.env.PI_COMPILED === "true";
const workerArg = process.argv[2];
if (!Bun.isMainThread && parentPort && isWorkerHostSelector(workerArg)) {
	installWorkerInbox(parentPort);
}

async function main(): Promise<void> {
	activateNativeProduct();
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
