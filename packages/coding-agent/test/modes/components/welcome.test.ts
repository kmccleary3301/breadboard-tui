import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	BB_LOGO,
	PI_LOGO,
	pickWeightedTip,
	WelcomeComponent,
} from "@oh-my-pi/pi-coding-agent/modes/components/welcome";
import { getAvailableThemes, getThemeByName, initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

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
const visLen = (s: string): number => [...stripAnsi(s)].length;
const hasRow = (lines: string[], row: string): boolean => lines.some(l => l.includes(row.trimEnd()));

describe("WelcomeComponent BreadBoard product mode", () => {
	const priorProduct = process.env.BREADBOARD_PRODUCT;
	afterEach(() => {
		if (priorProduct === undefined) delete process.env.BREADBOARD_PRODUCT;
		else process.env.BREADBOARD_PRODUCT = priorProduct;
	});

	it("renders the BreadBoard brand mark and drops the OMP mark in product mode", () => {
		process.env.BREADBOARD_PRODUCT = "1";
		const lines = new WelcomeComponent("0.1.0-rc.1", "model", "provider").render(90).map(stripAnsi);
		for (const row of BB_LOGO) expect(hasRow(lines, row)).toBe(true);
		expect(hasRow(lines, PI_LOGO[1])).toBe(false);
	});

	it("renders the OMP mark and no brand mark in native mode", () => {
		delete process.env.BREADBOARD_PRODUCT;
		const lines = new WelcomeComponent("17.4.0", "model", "provider").render(90).map(stripAnsi);
		for (const row of PI_LOGO) expect(hasRow(lines, row)).toBe(true);
		expect(hasRow(lines, BB_LOGO[2])).toBe(false);
	});

	it("titles the box with the exact BreadBoard product copy", () => {
		process.env.BREADBOARD_PRODUCT = "1";
		const header = stripAnsi(new WelcomeComponent("0.1.0-rc.1", "model", "provider").render(90)[0] ?? "");
		expect(header).toContain("BreadBoard v0.1.0-rc.1");
		expect(header).not.toContain("omp v");
	});

	it("keeps the exact OMP copy in native mode", () => {
		delete process.env.BREADBOARD_PRODUCT;
		const header = stripAnsi(new WelcomeComponent("17.4.0", "model", "provider").render(90)[0] ?? "");
		expect(header).toContain("omp v17.4.0");
		expect(header).not.toContain("BreadBoard");
	});

	it("keeps product rendering within the terminal width when narrow", () => {
		process.env.BREADBOARD_PRODUCT = "1";
		const welcome = new WelcomeComponent("0.1.0-rc.1", "model", "provider");
		for (const width of [20, 12, 6]) {
			const lines = welcome.render(width);
			for (const line of lines) expect(visLen(line)).toBeLessThanOrEqual(width);
			welcome.invalidate();
		}
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
