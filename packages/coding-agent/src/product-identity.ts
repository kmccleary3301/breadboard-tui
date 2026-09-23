/**
 * Immutable presentation identity for coding-agent surfaces.
 *
 * Executable names, paths, versions, and protocol identifiers remain owned by
 * `@oh-my-pi/pi-utils`; this module owns only user-visible art and copy. The
 * renderer types and the native identity come from `@oh-my-pi/pi-tui`; loading
 * this module registers the active identity with the renderer.
 */
import {
	freezePalette,
	OMP_PRODUCT_IDENTITY,
	type ProductIdentity,
	setProductIdentity,
} from "@oh-my-pi/pi-tui/product-identity";
import { IS_BREADBOARD_PRODUCT } from "@oh-my-pi/pi-utils/dirs";

export {
	type GradientPalette,
	type GradientStop,
	OMP_PRODUCT_IDENTITY,
	type ProductAppearance,
	type ProductIdentity,
	type ProductSymbolPreset,
} from "@oh-my-pi/pi-tui/product-identity";

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

const BREADBOARD_LOGO = Object.freeze([
	"░█▄▄ █▀█ █▀▀ ▄▀█ █▀▄░░░░░",
	"░█▄█ █▀▄ ██▄ █▀█ █▄▀░░░░░",
	"░░░░░█▄▄ █▀█ ▄▀█ █▀█ █▀▄░",
	"░░░░░█▄█ █▄█ █▀█ █▀▄ █▄▀░",
]);

export const BREADBOARD_PRODUCT_IDENTITY: ProductIdentity = Object.freeze({
	id: "breadboard",
	displayName: "BreadBoard",
	shortDisplayName: "BreadBoard",
	cliName: "bb",
	welcomeTitle: "BreadBoard",
	welcomeGreeting: "Welcome!",
	setupWordmark: "BreadBoard",
	composerFrameLabel: "Framed Rules",
	setupModelEmptyText: "No additional models discovered; BreadBoard's provider-free default remains available.",
	logoArt: BREADBOARD_LOGO,
	compactLogo: Object.freeze({ unicode: "ƁB", nerd: "bb", emoji: "🍞", ascii: "bb" }),
	gradientPalettes: Object.freeze({ dark: BREADBOARD_GRADIENT, light: BREADBOARD_GRADIENT }),
	defaultThemes: Object.freeze({ dark: "breadboard", light: "breadboard-light" }),
});

export const ACTIVE_PRODUCT_IDENTITY: ProductIdentity = IS_BREADBOARD_PRODUCT
	? BREADBOARD_PRODUCT_IDENTITY
	: OMP_PRODUCT_IDENTITY;

setProductIdentity(ACTIVE_PRODUCT_IDENTITY);
