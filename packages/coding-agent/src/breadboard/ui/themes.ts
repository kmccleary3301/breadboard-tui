import { registerBuiltinTheme } from "@oh-my-pi/pi-tui/theme";
import type { ThemeJson } from "@oh-my-pi/pi-tui/theme/schema";
import breadboardJson from "./themes/breadboard.json" with { type: "json" };
import breadboardLightJson from "./themes/breadboard-light.json" with { type: "json" };

let unregister: (() => void) | undefined;

export function registerBreadboardThemes(): () => void {
	if (unregister) return unregister;
	const unregDark = registerBuiltinTheme("breadboard", breadboardJson as ThemeJson);
	const unregLight = registerBuiltinTheme("breadboard-light", breadboardLightJson as ThemeJson);
	unregister = () => {
		unregDark();
		unregLight();
		unregister = undefined;
	};
	return unregister;
}
