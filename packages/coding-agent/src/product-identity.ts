/**
 * Immutable presentation identity for coding-agent surfaces.
 *
 * Executable names, paths, versions, and protocol identifiers remain owned by
 * `@oh-my-pi/pi-utils/dirs`; this module owns only user-visible art and copy.
 */
import { IS_BREADBOARD_PRODUCT } from "@oh-my-pi/pi-utils/dirs";
import breadboardSourceArt from "./assets/branding/breadboard_icon_bb_v1.provenance.json" with { type: "json" };

export type ProductAppearance = "dark" | "light";
export type ProductSymbolPreset = "unicode" | "nerdfont" | "ascii";
export type GradientStop = readonly [red: number, green: number, blue: number];

export interface GradientPalette {
	readonly stops: readonly GradientStop[];
	readonly ramp256: readonly number[];
}

export interface ProductSourceArtProvenance {
	readonly schemaVersion: string;
	readonly sourceRepository: string;
	readonly sourceCommit: string;
	readonly sourceTree: string;
	readonly sourcePath: string;
	readonly localPath: string;
	readonly assetVersion: string;
	readonly sha256: string;
}

/** Complete data needed to reskin product presentation without renderer edits. */
export interface ProductIdentity {
	readonly id: string;
	readonly displayName: string;
	readonly shortDisplayName: string;
	readonly cliName: string;
	readonly welcomeTitle: string;
	readonly logoArt: readonly string[];
	readonly compactLogo: Readonly<Record<ProductSymbolPreset, string>>;
	readonly gradientPalettes: Readonly<Record<ProductAppearance, GradientPalette>>;
	readonly defaultThemes: Readonly<Record<ProductAppearance, string>>;
	readonly sourceArt?: ProductSourceArtProvenance;
}

function freezePalette(stops: GradientStop[], ramp256: number[]): GradientPalette {
	for (const stop of stops) Object.freeze(stop);
	return Object.freeze({ stops: Object.freeze(stops), ramp256: Object.freeze(ramp256) });
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
);

const BREADBOARD_DARK_GRADIENT = freezePalette(
	[
		[214, 90, 10],
		[237, 132, 15],
		[255, 163, 56],
		[255, 196, 112],
	],
	[130, 166, 172, 208, 214, 220],
);

const BREADBOARD_LIGHT_GRADIENT = freezePalette(
	[
		[98, 42, 2],
		[140, 58, 4],
		[176, 74, 4],
		[204, 88, 8],
	],
	[52, 94, 130, 166, 172],
);

const OMP_LOGO = Object.freeze(["▀██████████▀", " ╘██    ██  ", "  ██    ██  ", "  ██    ██  ", " ▄██▄  ▄██▄ "]);
const BREADBOARD_LOGO = Object.freeze(["██    ██   ", "██    ██   ", "███▄  ███▄ ", "██ █  ██ █ ", "███▀  ███▀ "]);

const BREADBOARD_SOURCE_ART = Object.freeze({ ...breadboardSourceArt });

export const OMP_PRODUCT_IDENTITY: ProductIdentity = Object.freeze({
	id: "omp",
	displayName: "Oh My Pi",
	shortDisplayName: "OMP",
	cliName: "omp",
	welcomeTitle: "omp",
	logoArt: OMP_LOGO,
	compactLogo: Object.freeze({ unicode: "π", nerdfont: "\ue22c", ascii: "pi" }),
	gradientPalettes: Object.freeze({ dark: OMP_GRADIENT, light: OMP_GRADIENT }),
	defaultThemes: Object.freeze({ dark: "dark", light: "light" }),
});

export const BREADBOARD_PRODUCT_IDENTITY: ProductIdentity = Object.freeze({
	id: "breadboard",
	displayName: "BreadBoard",
	shortDisplayName: "BreadBoard",
	cliName: "bb",
	welcomeTitle: "BreadBoard",
	logoArt: BREADBOARD_LOGO,
	compactLogo: Object.freeze({ unicode: "bb", nerdfont: "bb", ascii: "bb" }),
	gradientPalettes: Object.freeze({ dark: BREADBOARD_DARK_GRADIENT, light: BREADBOARD_LIGHT_GRADIENT }),
	defaultThemes: Object.freeze({ dark: "breadboard", light: "breadboard-light" }),
	sourceArt: BREADBOARD_SOURCE_ART,
});

export const ACTIVE_PRODUCT_IDENTITY: ProductIdentity = IS_BREADBOARD_PRODUCT
	? BREADBOARD_PRODUCT_IDENTITY
	: OMP_PRODUCT_IDENTITY;
