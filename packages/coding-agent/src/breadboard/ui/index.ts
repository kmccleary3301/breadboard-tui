import { registerBreadboardStatusLine } from "./status-line";
import { registerBreadboardSymbols } from "./symbols";
import { registerBreadboardThemes } from "./themes";

let unregister: (() => void) | undefined;

/** Register bb themes, symbol presets and status-line presets once; later calls return the same handle. */
export function registerBreadboardUi(): () => void {
	if (unregister) return unregister;
	const handles = [registerBreadboardThemes(), registerBreadboardSymbols(), registerBreadboardStatusLine()];
	unregister = () => {
		for (const handle of handles.reverse()) handle();
		unregister = undefined;
	};
	return unregister;
}

export function unregisterBreadboardUi(): void {
	unregister?.();
}
