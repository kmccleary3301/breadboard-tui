import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { researchHelp } from "../cli/command-help";

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
		config: Flags.string({ multiple: true, description: "Load a config overlay (repeatable)" }),
	};

	async run(): Promise<void> {
		process.stderr.write("bb: research compare was retired with the Python engine bridge.\n");
		process.exitCode = 1;
	}
}
