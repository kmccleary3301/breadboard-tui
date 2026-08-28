import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { pickWeightedTip, WelcomeComponent } from "@oh-my-pi/pi-coding-agent/modes/components/welcome";
import { getAvailableThemes, getThemeByName, initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	BREADBOARD_PRODUCT_IDENTITY,
	OMP_PRODUCT_IDENTITY,
	type ProductIdentity,
} from "@oh-my-pi/pi-coding-agent/product-identity";

describe("WelcomeComponent", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("selects standard tip when preset is not unicode", () => {
		vi.spyOn(theme, "getSymbolPreset").mockReturnValue("nerd");

		const welcome = new WelcomeComponent("1.0.0", "model", "provider");
		expect(welcome.tip).not.toBe("Please use nerdfont 😭.");
		expect(welcome.tip).toBeDefined();
	});

	it("selects nerdfont tip with 10% probability under unicode preset", () => {
		vi.spyOn(theme, "getSymbolPreset").mockReturnValue("unicode");

		// 9% chance => selects special tip
		vi.spyOn(Math, "random").mockReturnValue(0.09);
		const welcomeSpecial = new WelcomeComponent("1.0.0", "model", "provider");
		expect(welcomeSpecial.tip).toBe("Please use nerdfont 😭.");

		// 10% chance => selects regular tip
		vi.spyOn(Math, "random").mockReturnValue(0.1);
		const welcomeRegular = new WelcomeComponent("1.0.0", "model", "provider");
		expect(welcomeRegular.tip).not.toBe("Please use nerdfont 😭.");
		expect(welcomeRegular.tip).toBeDefined();
	});

	it("weights [NEW] tips above ordinary tips in selection", () => {
		// Data-independent: tips.txt may legitimately carry zero "[NEW]" tips, so
		// exercise the weighting contract on a synthetic list.
		const tips = ["plain one", "shiny thing [NEW]", "plain two"] as const;

		const counts = new Map<string, number>();
		const samples = 10_000;
		for (let i = 0; i < samples; i++) {
			const tip = pickWeightedTip(tips, (i + 0.5) / samples); // sweep the selection domain uniformly
			counts.set(tip, (counts.get(tip) ?? 0) + 1);
		}

		let newMax = 0;
		let ordinaryMax = 0;
		for (const [tip, count] of counts) {
			if (/\[NEW\]\s*$/.test(tip)) newMax = Math.max(newMax, count);
			else ordinaryMax = Math.max(ordinaryMax, count);
		}

		// A "[NEW]" tip carries a >1 weight, so it covers strictly more of the
		// uniform selection domain than any single ordinary tip.
		expect(newMax).toBeGreaterThan(0);
		expect(newMax).toBeGreaterThan(ordinaryMax);
		expect(pickWeightedTip([], 0.5)).toBe("");
	});

	it("truncates a long model name inside the fixed left column and keeps the right column", () => {
		// Dynamic model labels must not influence the responsive breakpoint: a
		// long name is truncated with an ellipsis instead of collapsing the right
		// column or changing the box height when authoritative session data
		// replaces the prepaint labels.
		const modelName = "DeepSeek V4 Flash (2x usage)";
		const output = new WelcomeComponent("17.3.4", modelName, "opencode-go").render(55).join("\n");
		const plain = output.replace(/\x1b\[[0-9;]*m/g, "");

		expect(plain).not.toContain(modelName);
		expect(plain).toMatch(/DeepSeek V4 [^│]*…/);
		expect(plain).toContain("Recent sessions");
	});
});

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const hasRow = (lines: string[], row: string): boolean => lines.some(l => l.includes(row.trimEnd()));

describe("WelcomeComponent native identity", () => {
	it("renders the OMP mark and no BreadBoard mark", () => {
		const lines = new WelcomeComponent("18.0.1", "model", "provider").render(90).map(stripAnsi);
		for (const row of OMP_PRODUCT_IDENTITY.logoArt) expect(hasRow(lines, row)).toBe(true);
		expect(hasRow(lines, BREADBOARD_PRODUCT_IDENTITY.logoArt[2] ?? "")).toBe(false);
	});

	it("keeps the exact OMP copy", () => {
		const header = stripAnsi(new WelcomeComponent("18.0.1", "model", "provider").render(90)[0] ?? "");
		expect(header).toContain("omp v18.0.1");
		expect(header).not.toContain("BreadBoard");
	});

	it("renders an injected BreadBoard identity without product process state", () => {
		const lines = new WelcomeComponent("0.1.0-rc.4", "model", "provider", [], [], BREADBOARD_PRODUCT_IDENTITY, "dark")
			.render(90)
			.map(stripAnsi);

		expect(lines[0]).toContain("BreadBoard v0.1.0-rc.4");
		for (const row of BREADBOARD_PRODUCT_IDENTITY.logoArt) expect(hasRow(lines, row)).toBe(true);
		expect(hasRow(lines, OMP_PRODUCT_IDENTITY.logoArt[1] ?? "")).toBe(false);
	});

	it("reskins title, art, palette, and appearance without renderer changes", () => {
		const alternate: ProductIdentity = Object.freeze({
			id: "alternate",
			displayName: "Alternate Product",
			shortDisplayName: "Alternate",
			cliName: "alt",
			welcomeTitle: "Alternate",
			setupWordmark: "Alternate",
			composerFrameLabel: "Alternate Frame",
			logoArt: Object.freeze(["ALT"]),
			compactLogo: Object.freeze({ unicode: "A", nerd: "A", ascii: "A" }),
			gradientPalettes: Object.freeze({
				dark: Object.freeze({
					stops: Object.freeze([[255, 0, 0] as const, [128, 0, 0] as const]),
					ramp256: Object.freeze([196]),
				}),
				light: Object.freeze({
					stops: Object.freeze([[0, 0, 255] as const, [0, 0, 128] as const]),
					ramp256: Object.freeze([21]),
				}),
			}),
			defaultThemes: Object.freeze({ dark: "dark", light: "light" }),
		});
		const dark = new WelcomeComponent("1.2.3", "model", "provider", [], [], alternate, "dark").render(90);
		const light = new WelcomeComponent("1.2.3", "model", "provider", [], [], alternate, "light").render(90);

		expect(stripAnsi(dark[0] ?? "")).toContain("Alternate v1.2.3");
		expect(hasRow(dark.map(stripAnsi), "ALT")).toBe(true);
		expect(dark.join("\n")).not.toBe(light.join("\n"));
	});
});

describe("BreadBoard product themes", () => {
	it("registers the dune-orange brand themes for both appearances", async () => {
		const available = await getAvailableThemes();
		expect(available).toContain("breadboard");
		expect(available).toContain("breadboard-light");
		expect(await getThemeByName("breadboard")).toBeDefined();
		expect(await getThemeByName("breadboard-light")).toBeDefined();
	});
});
