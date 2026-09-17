/**
 * Immutable presentation identity for coding-agent surfaces.
 *
 * Executable names, paths, versions, and protocol identifiers remain owned by
 * `@oh-my-pi/pi-utils`; this module owns only user-visible art and copy.
 */
import { IS_BREADBOARD_PRODUCT } from "@oh-my-pi/pi-utils/dirs";

export type ProductAppearance = "dark" | "light";
export type ProductSymbolPreset = "unicode" | "nerd" | "ascii";
export type GradientStop = readonly [red: number, green: number, blue: number];

export interface GradientPalette {
	readonly stops: readonly GradientStop[];
	readonly ramp256: readonly number[];
	readonly ramp16: readonly number[];
}

/** Complete data needed to reskin product presentation without renderer edits. */
export interface ProductIdentity {
	readonly id: string;
	readonly displayName: string;
	readonly shortDisplayName: string;
	readonly cliName: string;
	readonly welcomeTitle: string;
	/** Wordmark shown below compact setup art. */
	readonly setupWordmark: string;
	/** User-facing label for the stable `pi` composer shape id. */
	readonly composerFrameLabel: string;
	/** Product-specific model remediation; native setup keeps its existing generic empty state. */
	readonly setupModelEmptyText?: string;
	readonly logoArt: readonly string[];
	readonly compactLogo: Readonly<Record<ProductSymbolPreset, string>>;
	readonly gradientPalettes: Readonly<Record<ProductAppearance, GradientPalette>>;
	readonly defaultThemes: Readonly<Record<ProductAppearance, string>>;
}

function freezePalette(stops: GradientStop[], ramp256: number[], ramp16: number[]): GradientPalette {
	for (const stop of stops) Object.freeze(stop);
	return Object.freeze({
		stops: Object.freeze(stops),
		ramp256: Object.freeze(ramp256),
		ramp16: Object.freeze(ramp16),
	});
}

const OMP_GRADIENT = freezePalette(
	[
		[255, 92, 200],
		[200, 110, 255],
		[120, 130, 255],
		[60, 200, 255],
		[120, 255, 220],
	],
	[199, 171, 135, 99, 75, 51, 87],
	[95, 95, 94, 96, 92],
);

// BreadBoard's canonical source palette: #ff4d6d → #d94dff → #4da3ff.
const BREADBOARD_GRADIENT = freezePalette(
	[
		[255, 77, 109],
		[217, 77, 255],
		[77, 163, 255],
	],
	[204, 171, 75],
	[91, 95, 94],
);

const OMP_LOGO = Object.freeze(["▀██████████▀", " ╘██    ██  ", "  ██    ██  ", "  ██    ██  ", " ▄██▄  ▄██▄ "]);
const BREADBOARD_LOGO = Object.freeze([
	"░█▄▄ █▀█ █▀▀ ▄▀█ █▀▄░░░░░",
	"░█▄█ █▀▄ ██▄ █▀█ █▄▀░░░░░",
	"░░░░░█▄▄ █▀█ ▄▀█ █▀█ █▀▄░",
	"░░░░░█▄█ █▄█ █▀█ █▀▄ █▄▀░",
]);

export const OMP_PRODUCT_IDENTITY: ProductIdentity = Object.freeze({
	id: "omp",
	displayName: "Oh My Pi",
	shortDisplayName: "OMP",
	cliName: "omp",
	welcomeTitle: "omp",
	setupWordmark: "O h   M y   P i",
	composerFrameLabel: "Pi",
	logoArt: OMP_LOGO,
	compactLogo: Object.freeze({ unicode: "π", nerd: "\ue22c", ascii: "pi" }),
	gradientPalettes: Object.freeze({ dark: OMP_GRADIENT, light: OMP_GRADIENT }),
	defaultThemes: Object.freeze({ dark: "dark", light: "light" }),
});

export const BREADBOARD_PRODUCT_IDENTITY: ProductIdentity = Object.freeze({
	id: "breadboard",
	displayName: "BreadBoard",
	shortDisplayName: "BreadBoard",
	cliName: "bb",
	welcomeTitle: "BreadBoard",
	setupWordmark: "BreadBoard",
	composerFrameLabel: "Framed Rules",
	setupModelEmptyText: "No additional models discovered; BreadBoard's provider-free default remains available.",
	logoArt: BREADBOARD_LOGO,
	compactLogo: Object.freeze({ unicode: "ƁB", nerd: "bb", ascii: "bb" }),
	gradientPalettes: Object.freeze({ dark: BREADBOARD_GRADIENT, light: BREADBOARD_GRADIENT }),
	defaultThemes: Object.freeze({ dark: "breadboard", light: "breadboard-light" }),
});

export const ACTIVE_PRODUCT_IDENTITY: ProductIdentity = IS_BREADBOARD_PRODUCT
	? BREADBOARD_PRODUCT_IDENTITY
	: OMP_PRODUCT_IDENTITY;
