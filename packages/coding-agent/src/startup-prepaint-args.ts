export interface StartupPrepaintArgs {
	readonly modelSelector?: string;
}

/** Parse only launch arguments that cannot submit work before the real session takes over. */
export function parseStartupPrepaintArgs(argv: readonly string[]): StartupPrepaintArgs | null {
	let modelSelector: string | undefined;
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--no-session") continue;
		if (argument?.startsWith("--model=") && argument.length > "--model=".length) {
			if (modelSelector !== undefined) return null;
			modelSelector = argument.slice("--model=".length);
			continue;
		}
		if (argument === "--model") {
			const value = argv[index + 1];
			if (!value || value.startsWith("-") || modelSelector !== undefined) return null;
			modelSelector = value;
			index++;
			continue;
		}
		return null;
	}
	return modelSelector === undefined ? {} : { modelSelector };
}
