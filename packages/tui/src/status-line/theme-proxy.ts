import { bindTheme, theme as initialTheme, type Theme } from "@oh-my-pi/pi-tui/theme";

/**
 * The active theme, followed through `bindTheme` so status-line renderers see a theme a product
 * registers after this module loaded. Shared by the status-line component and segments.
 */

let activeTheme: Theme = initialTheme;
bindTheme(value => {
	activeTheme = value;
});

export const theme = new Proxy({} as Theme, {
	get: (_target, property: string | symbol) => {
		const value = Reflect.get(activeTheme, property, activeTheme) as unknown;
		return typeof value === "function" ? value.bind(activeTheme) : value;
	},
});
