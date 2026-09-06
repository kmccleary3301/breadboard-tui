import { IS_BREADBOARD_PRODUCT } from "@oh-my-pi/pi-utils";
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import {
	type BreadboardEngineConnectionResult,
	BreadboardEngineLifecycleError,
	connectCanonicalBreadboardEnginePort,
} from "../breadboard/engine-port";
import {
	formatBreadboardConnectionError,
	writeLifecyclePresentation,
} from "../breadboard/lifecycle/lifecycle-presenter";
import { resolveProductBreadboardRunConfig } from "../breadboard/lifecycle/product-run-config";
import { BREADBOARD_ENGINE_MODES, parseSelectedBreadboardConfig } from "../breadboard/lifecycle/run-config";
import { researchHelp } from "../cli/command-help";
import { Settings } from "../config/settings";

function formatResearchError(error: unknown): string {
	return formatBreadboardConnectionError(error) ?? (error instanceof Error ? error.message : String(error));
}

function writeResearchFailure(error: unknown): number {
	if (error instanceof BreadboardEngineLifecycleError) {
		return writeLifecyclePresentation(error.result).exitCode || 1;
	}
	process.stderr.write(`${formatResearchError(error)}\n`);
	return 1;
}

function writeCleanupFailure(error: unknown): number {
	if (error instanceof BreadboardEngineLifecycleError) {
		return writeLifecyclePresentation(error.result).exitCode || 1;
	}
	process.stderr.write(`BreadBoard engine cleanup failed: ${formatResearchError(error)}\n`);
	return 1;
}

export default class Research extends Command {
	static description = researchHelp.description;
	static args = {
		action: Args.string({ required: true, options: ["compare"], description: "Compare recorded Sessions" }),
	};
	static flags = {
		definition: Flags.string({ required: true, description: "Workspace-relative authored Definition" }),
		world: Flags.string({ required: true, description: "Workspace-relative execution-world configuration" }),
		generation: Flags.string({ required: true, description: "Workspace-relative generation Lock" }),
		projection: Flags.string({ required: true, description: "Workspace-relative projection selection" }),
		compare: Flags.string({ required: true, description: "Ordered pair of recorded-run references: E,E_PRIME" }),
		"engine-mode": Flags.string({ options: [...BREADBOARD_ENGINE_MODES], description: "Engine mode" }),
		"engine-url": Flags.string({ description: "Exact engine endpoint URL" }),
		config: Flags.string({ multiple: true, description: "Load a config overlay (repeatable)" }),
	};

	async run(): Promise<void> {
		let connected: BreadboardEngineConnectionResult | undefined;
		let operationOutput: string | undefined;
		let operationExitCode: number | undefined;
		let operationFailed = false;
		let operationError: unknown;
		let cleanupError: unknown;
		let lifecycleFailure: BreadboardEngineLifecycleError | undefined;
		try {
			const { flags } = await this.parse(Research);
			const pair = flags.compare.split(",");
			const [left, right] = pair;
			if (pair.length !== 2 || !left || !right) throw new CliUsageError("--compare requires E,E_PRIME");
			const settings = await Settings.init({ cwd: process.cwd(), configFiles: flags.config });
			const selected = parseSelectedBreadboardConfig(settings.getRaw("breadboard"));
			const config = await resolveProductBreadboardRunConfig({
				cli: { engineMode: flags["engine-mode"], engineUrl: flags["engine-url"] },
				selectedConfig: { ...selected, requestTimeoutMs: selected.requestTimeoutMs ?? 60_000 },
				derivedOwnerExitPolicy: "attached",
				workspacePath: process.cwd(),
				isBreadboardProduct: IS_BREADBOARD_PRODUCT,
			});
			connected = await connectCanonicalBreadboardEnginePort(config, {
				onLifecycleFailure: result => {
					lifecycleFailure = new BreadboardEngineLifecycleError(result);
				},
				onLateSessionCloseError: error =>
					process.stderr.write(
						`BreadBoard session cleanup failed after caller abort: ${formatResearchError(error)}\n`,
					),
			});
			if (connected.kind !== "ready") {
				operationExitCode = writeLifecyclePresentation(connected.result).exitCode;
			} else {
				try {
					const result = await connected.port.compareResearch({
						definition: flags.definition,
						world: flags.world,
						generation: flags.generation,
						projection: flags.projection,
						compare: [left, right],
					});
					if (lifecycleFailure !== undefined) throw lifecycleFailure;
					operationOutput = `${result.resultJson}\n`;
					operationExitCode = result.exitCode;
				} catch (error) {
					operationFailed = true;
					operationError = lifecycleFailure ?? error;
				} finally {
					try {
						await connected.port.close();
					} catch (error) {
						cleanupError = error;
					}
				}
			}
			if (lifecycleFailure !== undefined && !operationFailed) cleanupError ??= lifecycleFailure;
			if (operationFailed) operationExitCode = writeResearchFailure(operationError);
			if (
				!operationFailed &&
				operationOutput !== undefined &&
				(cleanupError === undefined || operationExitCode !== 0)
			) {
				process.stdout.write(operationOutput);
			}
			if (cleanupError !== undefined) {
				const cleanupExitCode = writeCleanupFailure(cleanupError);
				if (operationExitCode === undefined || operationExitCode === 0) operationExitCode = cleanupExitCode;
			}
			if (operationExitCode !== undefined) process.exitCode = operationExitCode;
		} catch (error) {
			if (error instanceof CliUsageError) throw error;
			process.exitCode = writeResearchFailure(error);
		}
	}
}
