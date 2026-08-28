import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { BREADBOARD_PRODUCT_IDENTITY, OMP_PRODUCT_IDENTITY, type ProductIdentity } from "./product-identity";

function expectFrozenIdentity(identity: ProductIdentity): void {
	expect(Object.isFrozen(identity)).toBe(true);
	expect(Object.isFrozen(identity.logoArt)).toBe(true);
	expect(Object.isFrozen(identity.compactLogo)).toBe(true);
	expect(Object.isFrozen(identity.gradientPalettes)).toBe(true);
	expect(Object.isFrozen(identity.defaultThemes)).toBe(true);
	for (const palette of Object.values(identity.gradientPalettes)) {
		expect(Object.isFrozen(palette)).toBe(true);
		expect(Object.isFrozen(palette.stops)).toBe(true);
		expect(Object.isFrozen(palette.ramp256)).toBe(true);
		for (const stop of palette.stops) expect(Object.isFrozen(stop)).toBe(true);
	}
	if (identity.sourceArt) expect(Object.isFrozen(identity.sourceArt)).toBe(true);
}

describe("product identity", () => {
	test("freezes complete native and BreadBoard identity values", () => {
		expect(OMP_PRODUCT_IDENTITY).toMatchObject({
			id: "omp",
			displayName: "Oh My Pi",
			shortDisplayName: "OMP",
			cliName: "omp",
			welcomeTitle: "omp",
			defaultThemes: { dark: "dark", light: "light" },
		});
		expect(BREADBOARD_PRODUCT_IDENTITY).toMatchObject({
			id: "breadboard",
			displayName: "BreadBoard",
			shortDisplayName: "BreadBoard",
			cliName: "bb",
			welcomeTitle: "BreadBoard",
			defaultThemes: { dark: "breadboard", light: "breadboard-light" },
		});
		for (const identity of [OMP_PRODUCT_IDENTITY, BREADBOARD_PRODUCT_IDENTITY]) {
			expect(identity.logoArt).toHaveLength(5);
			expect(Object.values(identity.compactLogo).every(mark => mark.length > 0)).toBe(true);
			expectFrozenIdentity(identity);
		}
	});

	test("binds the packaged canonical source art to immutable provenance", async () => {
		const provenance = BREADBOARD_PRODUCT_IDENTITY.sourceArt;
		expect(provenance).toBeDefined();
		if (!provenance) throw new Error("BreadBoard source-art provenance is required");
		const assetPath = path.resolve(import.meta.dir, "assets/branding/breadboard_icon_bb_v1.svg");
		const bytes = await Bun.file(assetPath).arrayBuffer();
		expect(createHash("sha256").update(new Uint8Array(bytes)).digest("hex")).toBe(provenance.sha256);
		expect(provenance).toMatchObject({
			schemaVersion: "bb.product_source_art_provenance.v1",
			sourceCommit: "b7bd56e00abfd216fa560edba34eb05b823f59da",
			sourceTree: "fa73901f9dc2fad00bb7335754003afbafedaebc",
			assetVersion: "breadboard_icon_bb_v1",
			sha256: "87c6e65ca32d35b3604d6c3970bfa2a8d447440ea399809103df3e3bc49a873b",
		});
	});
});
