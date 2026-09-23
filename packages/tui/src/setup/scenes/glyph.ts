import { routeSelectListMouse, type SelectItem, SelectList, type SgrMouseEvent } from "@oh-my-pi/pi-tui";
import { getSelectListTheme, isValidSymbolPreset, type SymbolPreset, setSymbolPreset, theme } from "../../theme/theme";
import type { SetupScene, SetupSceneController, SetupSceneHost } from "./types";

const GLYPH_PRESETS = ["unicode", "nerd", "emoji", "ascii"] as const satisfies readonly SymbolPreset[];

const GLYPH_LABELS: Readonly<Record<SymbolPreset, string>> = {
	unicode: "Unicode",
	nerd: "Nerd Font",
	emoji: "Emoji",
	ascii: "ASCII",
};

const GLYPH_SAMPLES: Readonly<Record<SymbolPreset, string>> = {
	unicode: "✔  ✖  ▱  ◎  ╭─╮  ├─  •  ⠋  →",
	nerd: "      󰉋  ",
	emoji: "✔  ✖  📁  🎯  🧠  🚀",
	ascii: "[ok]  [x]  >  +  [D]  +-+  |--  *  ->",
};

/** One picker row per preset; the description column shows live sample glyphs instead of prose. */
const GLYPH_ITEMS: readonly SelectItem[] = GLYPH_PRESETS.map((preset, index) => ({
	value: preset,
	label: `${index + 1}  ${GLYPH_LABELS[preset]}`,
	description: GLYPH_SAMPLES[preset],
}));

function presetFromItem(item: SelectItem): SymbolPreset | undefined {
	return isValidSymbolPreset(item.value) ? item.value : undefined;
}

class GlyphSceneController implements SetupSceneController {
	title = "Choose glyph mode";
	subtitle = "Pick the row that renders cleanly in your terminal.";
	#selectList: SelectList;
	#previewRequest = 0;
	#committing = false;
	readonly #originalPreset: SymbolPreset;
	#previewChain: Promise<void> = Promise.resolve();
	/** Render line where the select list begins. */
	#listRowStart = 0;

	constructor(private readonly host: SetupSceneHost) {
		this.#originalPreset = theme.getSymbolPreset();
		this.#selectList = new SelectList(GLYPH_ITEMS, GLYPH_ITEMS.length, getSelectListTheme(), {
			wrapDescription: true,
			maxDescriptionRows: 1,
		});
		const currentIndex = GLYPH_PRESETS.indexOf(this.#originalPreset);
		this.#selectList.setSelectedIndex(currentIndex >= 0 ? currentIndex : 0);
		this.#selectList.onSelectionChange = item => {
			const preset = presetFromItem(item);
			if (preset) this.#preview(preset);
		};
		this.#selectList.onSelect = item => {
			const preset = presetFromItem(item);
			if (preset) void this.#commit(preset);
		};
		this.#selectList.onCancel = () => {
			void this.#cancel();
		};
	}

	invalidate(): void {
		if (this.#step) this.#step.invalidate();
		else this.#selectList.invalidate();
	}

	handleInput(data: string): void {
		if (this.#committing) return;
		const quickIndex = data >= "1" && data <= "4" ? Number(data) - 1 : -1;
		if (quickIndex >= 0) {
			const preset = GLYPH_PRESETS[quickIndex];
			this.#selectList.setSelectedIndex(quickIndex);
			this.#preview(preset);
			return;
		}
		if (this.#step) this.#step.handleInput(data);
		else this.#selectList.handleInput(data);
	}

	/** Wheel moves the highlight (live preview); hover lights the row under the pointer; click confirms it. */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (this.#committing) return;
		this.#step?.routeMouse(event, line, col);
	}

	render(width: number, maxLines?: number): readonly string[] {
		if (!this.#step) {
			this.#step = new WizardStep({
				kind: "choice",
				intro: new Text(theme.fg("muted", "If a row shows boxes, tofu, or misaligned icons, pick another."), 0, 0),
				content: this.#selectList,
				minContentLines: GLYPH_ITEMS.length,
				fitContent: () => {
					this.#selectList.setMaxVisible(GLYPH_ITEMS.length);
				},
			});
		}
		this.#step.setMaxHeight(maxLines);
		return this.#step.render(width);
	}

	async #commit(preset: SymbolPreset): Promise<void> {
		if (this.#committing) return;
		this.#committing = true;
		this.#previewRequest += 1;
		await this.#previewChain;
		this.host.ctx.settings.set("symbolPreset", preset);
		await setSymbolPreset(preset);
		await this.host.ctx.settings.flush();
		this.host.ctx.ui.invalidate();
		this.host.finish("done");
	}

	async #cancel(): Promise<void> {
		if (this.#committing) return;
		this.#committing = true;
		this.#previewRequest += 1;
		await this.#previewChain;
		await setSymbolPreset(this.#originalPreset);
		this.host.ctx.ui.invalidate();
		this.host.requestRender();
		this.host.finish("skipped");
	}

	#preview(preset: SymbolPreset): void {
		const request = ++this.#previewRequest;
		this.#previewChain = this.#previewChain.then(async () => {
			if (request !== this.#previewRequest || this.#committing) return;
			await setSymbolPreset(preset);
			if (request !== this.#previewRequest || this.#committing) return;
			this.#host.ctx.ui.invalidate();
			this.#host.requestRender();
		});
	}
}

/**
 * Preview and persist the terminal glyph preset. Skipped once the Glyph
 * Protocol handshake confirmed the terminal renders omp's bundled icons: every
 * row renders cleanly there, and the default `unicode` preset already upgrades
 * to nerd at runtime while staying safe on terminals without the protocol.
 */
export const glyphSetupScene: SetupScene = {
	id: "glyph-mode",
	title: "Choose glyph mode",
	minVersion: 1,
	shouldRun: () => !TERMINAL.glyphProtocol,
	mount: host => new GlyphSceneController(host),
};
