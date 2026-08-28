import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getWelcomeTips, renderWelcomeTip } from "@oh-my-pi/pi-coding-agent/modes/components/welcome";
import { ALL_SCENES } from "@oh-my-pi/pi-coding-agent/modes/setup-wizard";
import { renderSetupOutro } from "@oh-my-pi/pi-coding-agent/modes/setup-wizard/scenes/outro";
import { renderSetupSplash, SETUP_SPLASH_MS } from "@oh-my-pi/pi-coding-agent/modes/setup-wizard/scenes/splash";
import type { SetupScene, SetupSceneHost } from "@oh-my-pi/pi-coding-agent/modes/setup-wizard/scenes/types";
import { SetupWizardComponent } from "@oh-my-pi/pi-coding-agent/modes/setup-wizard/wizard-overlay";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	BREADBOARD_PRODUCT_IDENTITY,
	OMP_PRODUCT_IDENTITY,
	type ProductIdentity,
} from "@oh-my-pi/pi-coding-agent/product-identity";
import { visibleWidth } from "@oh-my-pi/pi-tui";

const NATIVE_TIPS = [
	"Tired of typing \"keep going\"? Just send a '.'",
	"You can /btw to ask a side question",
	"Use /tan to fork the current conversation into a background agent",
	"Ctrl+D can be used to exit, but with your draft saved!",
	"Find out which model you emotionally abuse the most with `omp stats`",
	"Try task isolation to create CoW worktrees",
	"Need a cheap nested model call? Use `completion(x...)`. Have a big batch of tasks? Ask clanker to use it!",
	"Spaghetti code? Try complaining with /omfg",
	"Did you know? Each kitty/tmux/cmux/zellij/wezterm split keeps its own session — `omp -c` resumes the right one",
	"Drop the word `ultrathink` in your message for harder multi-step reasoning — watch it glow rainbow as you type",
	"Say `orchestrate` in your message to drive a multi-phase task with parallel subagents — watch it glow as you type",
	"Say `workflowz` in your message to drive the task with parallel subagents in eval — watch it glow as you type",
	"Log in to several accounts of the same provider — `/login` again — and omp load-balances across them automatically",
	"Run `omp auth-broker serve` once and every machine pulls live tokens over the wire — refresh keys never leave the host; `omp auth-gateway` fronts it as a drop-in proxy any OpenAI-compatible client can hit",
	"Press alt+p (or /switch) to switch provider, and ctrl+p to cycle role models smol -> slow -> etc",
	"Press ctrl+r to search your prompt history and reuse a past message",
	"`/force read` pins the next turn to one specific tool when the model keeps reaching for the wrong one",
	"`/copy code` grabs the last code block to your clipboard — `/copy cmd` grabs the last shell/python command",
	"`/shake` rips heavy tool results out of context to reclaim tokens without a full /compact — `/shake images` drops just images",
	"Pair up live: `/collab` shares your session through an end-to-end encrypted relay link — a teammate runs `/join <link>` to watch tool calls stream and prompt the agent from their own omp",
	"Press ← ← to drill into a running or finished agent and inspect its tool calls and transcript",
	"Hit a Codex rate limit? `/usage reset` spends a saved reset credit to immediately restore your quota",
	"No native tool_calling? Inference provider botches parsing them? `PI_DIALECT=glm|kimi|anthropic…` rolls it locally for them!",
	"Turn on `/advisor` to attach a second model that reviews every turn and quietly injects advice",
	"Try starting your prompt with a ->, and writing a list (1. Do X, 2. Do Y)",
	"Press shift+tab to cycle through reasoning effort levels",
	"Lint/type errors piling up? `omp cleanse` (or /cleanse right here) hunts project diagnostics and fixes them with parallel subagents — esc cancels",
] as const;

beforeAll(async () => {
	await initTheme(false, "unicode", false, "titanium", "light");
});

afterEach(async () => {
	await initTheme(false, "unicode", false, "titanium", "light");
});

function stripFrame(lines: readonly string[]): string[] {
	return lines.map(line => Bun.stripANSI(line));
}

function enlargedLogo(identity: ProductIdentity): string[] {
	return identity.logoArt.flatMap(line => {
		const wide = [...line].map(char => (char === " " ? "  " : `${char}${char}`)).join("");
		return [wide, wide];
	});
}

function assertFrameGeometry(lines: readonly string[], width: number, height: number): void {
	expect(lines).toHaveLength(height);
	for (const line of lines) expect(visibleWidth(line)).toBe(width);
}

function assertFullHero(lines: readonly string[], width: number, height: number, identity: ProductIdentity): void {
	const plain = stripFrame(lines);
	const logo = enlargedLogo(identity);
	const logoWidth = Math.max(...logo.map(line => visibleWidth(line)));
	const left = Math.floor((width - logoWidth) / 2);
	const top = Math.max(2, Math.floor(height * 0.16));
	for (let row = 0; row < logo.length; row++) {
		const actual = [...(plain[top + row] ?? "")];
		for (let col = 0; col < (logo[row]?.length ?? 0); col++) {
			const expected = logo[row]?.[col];
			if (expected !== " ") expect(actual[left + col]).toBe(expected);
		}
	}
}

function assertNoNativeIdentity(text: string): void {
	expect(text).not.toMatch(/\bomp\b/i);
	expect(text).not.toContain("Oh My Pi");
	expect(text).not.toContain("O h   M y   P i");
	expect(text).not.toContain("π");
}

describe("setup identity renderers", () => {
	it.each([OMP_PRODUCT_IDENTITY, BREADBOARD_PRODUCT_IDENTITY])(
		"renders deterministic full start/mid/end frames for $id",
		identity => {
			const frames = [0, SETUP_SPLASH_MS / 2, SETUP_SPLASH_MS].map(elapsed =>
				renderSetupSplash(80, 30, elapsed, identity, "dark"),
			);
			for (const frame of frames) {
				assertFrameGeometry(frame, 80, 30);
				assertFullHero(frame, 80, 30, identity);
			}
			expect(frames[0]?.join("\n")).not.toBe(frames[1]?.join("\n"));
			expect(frames[1]?.join("\n")).not.toBe(frames[2]?.join("\n"));
		},
	);

	it.each([OMP_PRODUCT_IDENTITY, BREADBOARD_PRODUCT_IDENTITY])(
		"renders compact enlarged and original art with the $id wordmark",
		identity => {
			for (const height of [16, 10]) {
				const frame = renderSetupSplash(48, height, 700, identity, "dark");
				assertFrameGeometry(frame, 48, height);
				const text = stripFrame(frame).join("\n");
				expect(text).toContain(identity.setupWordmark);
				const expectedArt = height >= 14 ? enlargedLogo(identity) : identity.logoArt;
				for (const row of expectedArt) expect(text).toContain(row.trim());
			}
		},
	);

	it("keeps product setup frames free of native identity while preserving native copy", () => {
		const productCompact = stripFrame(
			renderSetupSplash(48, 16, SETUP_SPLASH_MS / 2, BREADBOARD_PRODUCT_IDENTITY, "dark"),
		).join("\n");
		assertNoNativeIdentity(productCompact);
		expect(productCompact).toContain("BreadBoard");

		const nativeCompact = stripFrame(
			renderSetupSplash(48, 16, SETUP_SPLASH_MS / 2, OMP_PRODUCT_IDENTITY, "dark"),
		).join("\n");
		expect(nativeCompact).toContain("O h   M y   P i");
		expect(nativeCompact).not.toContain("BreadBoard");

		const productOutro = renderSetupOutro(80, 24, 600, BREADBOARD_PRODUCT_IDENTITY, "dark");
		const nativeOutro = renderSetupOutro(80, 24, 600, OMP_PRODUCT_IDENTITY, "dark");
		assertFrameGeometry(productOutro, 80, 24);
		assertFrameGeometry(nativeOutro, 80, 24);
		expect(stripFrame(productOutro).join("\n")).toContain(BREADBOARD_PRODUCT_IDENTITY.logoArt[2] ?? "");
		expect(stripFrame(nativeOutro).join("\n")).toContain(OMP_PRODUCT_IDENTITY.logoArt[2] ?? "");
		assertNoNativeIdentity(stripFrame(productOutro).join("\n"));
	});

	it("selects distinct BreadBoard palettes for dark and light appearance", () => {
		const dark = renderSetupSplash(48, 16, 900, BREADBOARD_PRODUCT_IDENTITY, "dark").join("\n");
		const light = renderSetupSplash(48, 16, 900, BREADBOARD_PRODUCT_IDENTITY, "light").join("\n");
		expect(dark).not.toBe(light);
	});
});

function wizardContext(rows: number): InteractiveModeContext {
	return {
		ui: {
			terminal: { rows },
			requestRender: () => {},
			setFocus: () => {},
		},
	} as unknown as InteractiveModeContext;
}

function identityScene(): SetupScene {
	return {
		id: "identity-check",
		title: "Identity check",
		minVersion: 1,
		mount: () => ({
			title: "Identity check",
			subtitle: "Deterministic scene body",
			render: () => ["BODY"],
			invalidate: () => {},
		}),
	};
}

describe("SetupWizardComponent identity boundary", () => {
	it.each([OMP_PRODUCT_IDENTITY, BREADBOARD_PRODUCT_IDENTITY])(
		"uses injected $id identity through splash, scene header, and outro",
		async identity => {
			let now = 0;
			const component = new SetupWizardComponent(wizardContext(24), [identityScene()], {
				identity,
				now: () => now,
			});
			const pending = component.run();
			try {
				const splash = stripFrame(component.render(80)).join("\n");
				component.handleInput("\r");
				now = 421;
				const scene = stripFrame(component.render(80)).join("\n");
				expect(scene).toContain(identity.welcomeTitle);
				expect(scene).toContain(identity.logoArt[2] ?? "");
				component.handleInput("\x03");
				now = 1021;
				const outro = stripFrame(component.render(80)).join("\n");
				expect(outro).toContain(identity.logoArt[2] ?? "");
				expect(outro).toContain("Setup saved");
				if (identity.id === BREADBOARD_PRODUCT_IDENTITY.id) {
					assertNoNativeIdentity(`${splash}\n${scene}\n${outro}`);
				} else {
					expect(scene).toContain("omp");
					expect(`${splash}\n${scene}\n${outro}`).not.toContain("BreadBoard");
				}
				component.handleInput("\r");
				await pending;
			} finally {
				component.dispose();
			}
		},
	);
});

function modelHost(identity: ProductIdentity): SetupSceneHost {
	const settings = Settings.isolated();
	return {
		identity,
		ctx: {
			settings,
			session: {
				model: undefined,
				modelRegistry: {
					getAvailable: () => [],
					getAll: () => [],
					refresh: async () => {},
				},
			},
			ui: { terminal: { rows: 30 } },
		},
		requestRender: () => {},
		finish: () => {},
		setFocus: () => {},
		restoreFocus: () => {},
	} as unknown as SetupSceneHost;
}

describe("setup remediation identity", () => {
	it("keeps native model-empty copy and explains the product provider-free default", () => {
		const scene = ALL_SCENES.find(candidate => candidate.id === "model");
		if (!scene) throw new Error("model setup scene is missing");
		const native = stripFrame(scene.mount(modelHost(OMP_PRODUCT_IDENTITY)).render(100)).join("\n");
		const product = stripFrame(scene.mount(modelHost(BREADBOARD_PRODUCT_IDENTITY)).render(100)).join("\n");
		expect(native).toContain("No models available in this scope");
		expect(native).not.toContain("BreadBoard");
		expect(product).toContain("BreadBoard's provider-free default remains available");
		expect(product).not.toMatch(/API key.*required/i);
	});
});

describe("identity-resolved tips", () => {
	it("reproduces every native tip byte-for-byte", () => {
		expect(getWelcomeTips(OMP_PRODUCT_IDENTITY)).toEqual(NATIVE_TIPS);
	});

	it("renders every product tip with supported identity data and filters native auth commands", () => {
		const tips = getWelcomeTips(BREADBOARD_PRODUCT_IDENTITY);
		expect(tips).toHaveLength(NATIVE_TIPS.length - 1);
		const text = tips.join("\n");
		expect(text).toContain("`bb stats`");
		expect(text).toContain("`bb -c`");
		expect(text).toContain("BreadBoard load-balances");
		expect(text).toContain("own BreadBoard");
		expect(text).toContain("`bb cleanse`");
		expect(text).not.toMatch(/\bomp\b/i);
		expect(text).not.toMatch(/auth-broker|auth-gateway/);
		expect(text).not.toMatch(/\{(?:cli|display)\}/);
		for (const tip of tips) {
			const rendered = stripFrame(renderWelcomeTip(tip, 120)).join("\n");
			expect(rendered).toContain("Tip:");
			assertNoNativeIdentity(rendered);
		}
	});
});

describe("identity module startup graph", () => {
	it("does not pull setup, provider-auth, or OAuth modules into the data-only owner", async () => {
		const entrypoint = path.resolve(import.meta.dir, "../src/product-identity.ts");
		const result = await Bun.build({ entrypoints: [entrypoint], target: "bun", format: "esm", metafile: true });
		expect(result.success).toBe(true);
		const inputs = Object.keys(result.metafile?.inputs ?? {});
		expect(inputs.some(input => /setup-wizard|provider-auth|oauth/i.test(input))).toBe(false);
	});
});
