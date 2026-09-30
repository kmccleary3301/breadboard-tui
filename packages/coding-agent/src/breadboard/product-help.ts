/**
 * BreadBoard product help content and registration.
 */
import chalk from "@oh-my-pi/pi-utils/chalk";
import { APP_NAME } from "@oh-my-pi/pi-utils/dirs";
import { registerExtraHelpSection } from "../cli/help-extra";
import { registerLaunchExamples } from "../commands/launch-help";

export const BREADBOARD_LAUNCH_EXAMPLES: string[] = [
	`# Interactive mode in the selected workspace\n  ${APP_NAME}`,
	`# Choose a harness and a model\n  ${APP_NAME} --harness path/to/harness.yaml --model provider/model`,
	`# Run the supported setup flow\n  ${APP_NAME} setup`,
	`# Export a session file to HTML\n  ${APP_NAME} --export path/to/session.jsonl`,
];

export function formatBreadboardExtraHelp(): string {
	return `${chalk.bold("BreadBoard:")}
  ${APP_NAME} runs OMP's own loop on a BreadBoard harness. --harness takes a built-in harness id
  or a spec path (.yaml); /harness shows, lists and reloads harnesses.
  BREADBOARD_OMP_AGENT_DIR   - Use an existing OMP authentication store
  BREADBOARD_CONFIG_DIR      - BreadBoard configuration and native cache directory

`;
}

let unregister: (() => void) | undefined;

export function registerBreadboardHelp(): () => void {
	if (unregister) return unregister;
	const unregisterExamples = registerLaunchExamples(BREADBOARD_LAUNCH_EXAMPLES);
	const unregisterExtra = registerExtraHelpSection(formatBreadboardExtraHelp);
	unregister = () => {
		unregisterExtra();
		unregisterExamples();
		unregister = undefined;
	};
	return unregister;
}
