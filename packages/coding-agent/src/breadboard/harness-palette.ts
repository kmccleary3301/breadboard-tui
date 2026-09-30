import type { SlashCommand } from "@oh-my-pi/pi-tui";
import { getSlashCommandTypeIcon } from "@oh-my-pi/pi-tui/theme/tui-adapters";
import type { Settings } from "../config/settings";
import type { HarnessPort } from "./harness-port";
import { BUILTIN_SLASH_COMMAND_RESERVED_NAMES } from "../slash-commands/builtin-registry";
import {
	HARNESS_COMMAND_NAMES,
	harnessCommandsAsSlashCommands,
	readHarnessPaletteSettings,
} from "../slash-commands/harness";

/** A builtin the harness does not own; the palette never replaces or adds over one. */
function isOtherBuiltin(name: string): boolean {
	return BUILTIN_SLASH_COMMAND_RESERVED_NAMES.has(name) && !HARNESS_COMMAND_NAMES.has(name);
}

export class HarnessPaletteController {
	readonly #settings: Settings;
	readonly #harnessPort: HarnessPort | undefined;
	#harnessPaletteNames = new Set<string>();

	constructor(settings: Settings, harnessPort?: HarnessPort) {
		this.#settings = settings;
		this.#harnessPort = harnessPort;
	}

	/** Commands arrive with icons already resolved; replacements keep the static entry's icon. */
	apply(staticSlashCommands: readonly SlashCommand[]): SlashCommand[] {
		const snapshot = this.#harnessPort?.current() ?? null;
		if (!snapshot) {
			this.#harnessPaletteNames.clear();
			return [...staticSlashCommands];
		}
		const dynamicCommands = new Map(
			harnessCommandsAsSlashCommands(snapshot, readHarnessPaletteSettings(this.#settings)).map(command => [
				command.name,
				command,
			]),
		);
		const namesToReplace = new Set<string>([
			...HARNESS_COMMAND_NAMES,
			...this.#harnessPaletteNames,
			...dynamicCommands.keys(),
		]);
		this.#harnessPaletteNames = new Set(dynamicCommands.keys());
		const result: SlashCommand[] = [];
		for (const command of staticSlashCommands) {
			if (isOtherBuiltin(command.name)) {
				result.push(command);
				continue;
			}
			const replacement = dynamicCommands.get(command.name);
			if (replacement) {
				result.push({ ...command, ...replacement, icon: command.icon, iconName: command.iconName });
				dynamicCommands.delete(command.name);
			} else if (!namesToReplace.has(command.name)) {
				// Custom / third-party commands outside harness ownership are preserved
				result.push(command);
			}
		}
		for (const command of dynamicCommands.values()) {
			if (!isOtherBuiltin(command.name)) {
				result.push({ ...command, icon: getSlashCommandTypeIcon("action"), iconName: "action" });
			}
		}
		return result;
	}
}
