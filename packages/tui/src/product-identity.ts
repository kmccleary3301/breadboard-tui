/**
 * Presentation identity consumed by welcome, setup, theme defaults, and composer previews.
 *
 * The renderer ships the native identity. An embedding application registers its own
 * identity once at startup with {@link setProductIdentity}; defaults then follow it.
 */
export type ProductAppearance = "dark" | "light";
export type ProductSymbolPreset = "unicode" | "nerd" | "emoji" | "ascii";
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
	/** Welcome box greeting; stock OMP's "Welcome back!" when unset. */
	readonly welcomeGreeting?: string;
	/** Wordmark shown below compact setup art. */
	readonly setupWordmark: string;
	/** User-facing label for the stable `pi` composer shape id. */
	readonly composerFrameLabel: string;
	/** Optional overrides for composer shape option labels (e.g. { band: "Status Band", box: "Rounded Box (Default)" }). */
	readonly composerShapeLabels?: Readonly<Record<string, string>>;
	/** Optional preview status-source factory for the composer setup scene. */
	readonly createPreviewStatus?: (host: unknown) => unknown;
	/** Product-specific model remediation; native setup keeps its generic empty state. */
	readonly setupModelEmptyText?: string;
	readonly logoArt: readonly string[];
	readonly compactLogo: Readonly<Record<ProductSymbolPreset, string>>;
	readonly gradientPalettes: Readonly<Record<ProductAppearance, GradientPalette>>;
	readonly defaultThemes: Readonly<Record<ProductAppearance, string>>;
}

export function freezePalette(stops: GradientStop[], ramp256: number[], ramp16: number[]): GradientPalette {
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

export const OMP_PRODUCT_IDENTITY: ProductIdentity = Object.freeze({
	id: "omp",
	displayName: "Oh My Pi",
	shortDisplayName: "OMP",
	cliName: "omp",
	welcomeTitle: "omp",
	setupWordmark: "O h   M y   P i",
	composerFrameLabel: "Pi",
	logoArt: Object.freeze(["▀██████████▀", " ╘██    ██  ", "  ██    ██  ", "  ██    ██  ", " ▄██▄  ▄██▄ "]),
	compactLogo: Object.freeze({ unicode: "π", nerd: "\ue22c", emoji: "π", ascii: "pi" }),
	gradientPalettes: Object.freeze({ dark: OMP_GRADIENT, light: OMP_GRADIENT }),
	defaultThemes: Object.freeze({ dark: "dark", light: "light" }),
});

let activeProductIdentity: ProductIdentity = OMP_PRODUCT_IDENTITY;

/** Identity used when a caller does not pass one explicitly. */
export function getProductIdentity(): ProductIdentity {
	return activeProductIdentity;
}

/** Register the embedding application's identity. Call once, before rendering. */
export function setProductIdentity(identity: ProductIdentity): void {
	activeProductIdentity = identity;
}
