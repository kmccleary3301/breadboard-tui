import { registerSymbolOverrides, registerSymbolPreset } from "@oh-my-pi/pi-tui/theme";
import monochromeSymbols from "./monochrome-symbols.json" with { type: "json" };

let unregister: (() => void) | undefined;

export function registerBreadboardSymbols(): () => void {
	if (unregister) return unregister;

	const unregEmoji = registerSymbolPreset(
		"emoji",
		{
			"tab.breadboard": "🍞",
		},
		{
			inherit: "unicode",
			label: "Emoji",
			sample: "✔  ✖  📁  🎯  🧠  🚀",
			description: "Expressive icons; preview terminal alignment",
			spinnerFrames: {
				status: ["⏳", "⌛", "🔄", "🔃"],
				activity: ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"],
			},
		},
	);

	const unregUnicode = registerSymbolOverrides(
		"unicode",
		{
			...(monochromeSymbols as Record<string, string>),
			"tab.breadboard": "⌘",
		},
		{
			sample: "✔  ✖  ▱  ◎  ╭─╮  ├─  •  ⠋  →",
		},
	);

	const unregNerd = registerSymbolOverrides("nerd", {
		"tab.breadboard": "󰐱",
	});

	const unregAscii = registerSymbolOverrides("ascii", {
		"tab.breadboard": "[B]",
	});

	unregister = () => {
		unregEmoji();
		unregUnicode();
		unregNerd();
		unregAscii();
		unregister = undefined;
	};

	return unregister;
}
