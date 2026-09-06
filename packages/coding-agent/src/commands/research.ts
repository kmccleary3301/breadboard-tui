import { IS_BREADBOARD_PRODUCT } from "@oh-my-pi/pi-utils";
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { connectCanonicalBreadboardEnginePort } from "../breadboard/engine-port";
import { writeLifecyclePresentation } from "../breadboard/lifecycle/lifecycle-presenter";
import { resolveProductBreadboardRunConfig } from "../breadboard/lifecycle/product-run-config";
import { BREADBOARD_ENGINE_MODES, parseSelectedBreadboardConfig } from "../breadboard/lifecycle/run-config";
import { researchHelp } from "../cli/command-help";
import { Settings } from "../config/settings";

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
		const connected = await connectCanonicalBreadboardEnginePort(config, {
			onLateSessionCloseError: error => process.stderr.write(`${String(error)}\n`),
		});
		if (connected.kind !== "ready") {
			process.exitCode = writeLifecyclePresentation(connected.result).exitCode;
			return;
		}
		try {
			const result = await connected.port.compareResearch({
				definition: flags.definition,
				world: flags.world,
				generation: flags.generation,
				projection: flags.projection,
				compare: [left, right],
			});
			process.stdout.write(`${JSON.stringify(result)}\n`);
			process.exitCode = result.exit_code;
		} finally {
			await connected.port.close();
		}
	}
}
