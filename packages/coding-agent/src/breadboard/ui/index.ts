import { registerBreadboardStatusLine } from "./status-line";
import { registerBreadboardSymbols } from "./symbols";
import { registerBreadboardThemes } from "./themes";

export function registerBreadboardUi(): void {
	registerBreadboardStatusLine();
	registerBreadboardThemes();
	registerBreadboardSymbols();
}

export { registerBreadboardStatusLine };
