#!/usr/bin/env bun
import { parentPort } from "node:worker_threads";
import { installWorkerInbox, isWorkerHostSelector } from "@oh-my-pi/pi-utils/worker-host";

import { activateBreadboardProduct } from "./breadboard/product-settings";
import { parseStartupPrepaintArgs } from "./startup-prepaint-args";

const isCompiled = process.env.PI_COMPILED === "true";
const workerArg = process.argv[2];
if (!Bun.isMainThread && parentPort && isWorkerHostSelector(workerArg)) {
	installWorkerInbox(parentPort);
}

async function main(): Promise<void> {
	process.env.BREADBOARD_PRODUCT = "1";
	const rawArgv = process.argv.slice(2);
	const { extractProfileFlags } = await import("./cli/profile-bootstrap");
	const extracted = extractProfileFlags(rawArgv);
	const resolvedArgv = extracted.argv;

	if (resolvedArgv[0] === "--version" || resolvedArgv[0] === "-v") {
		const { formatBreadboardVersion } = await import("@oh-my-pi/pi-utils/product-distribution");
		process.stdout.write(`${formatBreadboardVersion()}\n`);
		return;
	}

	const { isUpdateCommand, formatUpdateRefusal } = await import("./breadboard/update-refusal");
	if (isUpdateCommand(rawArgv)) {
		process.stderr.write(`${formatUpdateRefusal()}\n`);
		process.exit(2);
	}

	const { detectBridgeRefusal, detectSettingsBridgeRefusal, formatBridgeRefusal } =
		await import("./breadboard/bridge-refusal");
	const refusal = detectBridgeRefusal({ argv: resolvedArgv, environment: process.env });
	if (refusal) {
		process.stderr.write(`${formatBridgeRefusal(refusal.source, refusal.value)}\n`);
		process.exit(2);
	}

	const metadataOnly = ["--version", "-v", "--help", "-h", "help", "--license"].includes(resolvedArgv[0] ?? "");
	if (!metadataOnly) {
		const settingsRefusal = await detectSettingsBridgeRefusal(resolvedArgv);
		if (settingsRefusal) {
			process.stderr.write(`${formatBridgeRefusal(settingsRefusal.source, settingsRefusal.value)}\n`);
			process.exit(2);
		}
	}

	let stopStartupComposer: (() => void) | undefined;
	// bb themes, symbols and status-line presets register before the prepaint resolves the cached theme.
	const breadboardUi = import("./breadboard/ui");
	if (Bun.isMainThread && !process.env.PI_TIMING && process.stdin.isTTY === true && process.stdout.isTTY === true) {
		const startupPrepaint = parseStartupPrepaintArgs(resolvedArgv);
		if (startupPrepaint !== null) {
			const [{ VERSION }, { beginStartupComposer, stopPendingStartupComposer }, { registerBreadboardUi }] =
				await Promise.all([import("@oh-my-pi/pi-utils/dirs"), import("./modes/startup-composer"), breadboardUi]);
			registerBreadboardUi();
			beginStartupComposer({ version: VERSION, modelSelector: startupPrepaint.modelSelector });
			stopStartupComposer = stopPendingStartupComposer;
		}
	}
	// Product setting defaults must precede the shared CLI, not the first paint.
	// Deferring their module graph lets the cached composer paint while it loads.
	try {
		if (!metadataOnly) await activateBreadboardProduct();
	} catch (error) {
		stopStartupComposer?.();
		throw error;
	}
	(await breadboardUi).registerBreadboardUi();
	const { runCli } = await import("./cli");
	// A compiled CLI module self-dispatches from its process entry. Source
	// execution imports cli.ts as a module, so the wrapper owns invocation there.
	if (!isCompiled && Bun.isMainThread) await runCli(rawArgv, { processEntry: true });
}

if (import.meta.main || isCompiled || !Bun.isMainThread) {
	main().catch((error: unknown) => {
		process.stderr.write(`${Bun.inspect(error, { colors: process.stderr.isTTY === true })}\n`);
		process.exit(1);
	});
}
