import { type SgrMouseEvent } from "../../mouse";
import { TERMINAL } from "../../terminal-capabilities";
import { type SelectItem, SelectList } from "../../components/select-list";
import { Text } from "../../components/text";
import { WizardStep } from "../../components/wizard-step";
import { getSelectListTheme, getSymbolPresetInfos, type SymbolPreset, setSymbolPreset, theme } from "../../theme/theme";
import type { SetupScene, SetupSceneController, SetupSceneHost } from "./types";

function getGlyphItems(): { presets: readonly SymbolPreset[]; items: readonly SelectItem[] } {
	const infos = getSymbolPresetInfos();
	const presets = infos.map(i => i.preset);
	const items: SelectItem[] = infos.map((info, index) => ({
		value: info.preset,
		label: `${index + 1}  ${info.label}`,
		description: info.preset === "nerd" ? `${info.sample}  ╭─╮  ├─  ◆  ✔  ✖` : info.sample,
	}));
	return { presets, items };
}

class GlyphSceneController implements SetupSceneController {
	title = "Choose glyph mode";
	subtitle = "Pick the row that renders cleanly in your terminal.";
	#selectList: SelectList;
	#previewRequest = 0;
	#committing = false;
	readonly #presets: readonly SymbolPreset[];
	readonly #originalPreset: SymbolPreset;
	/** Previews apply in order so a slow preview can never land after commit or cancel. */
	#previewChain: Promise<void> = Promise.resolve();
	#step: WizardStep | undefined;

	readonly #host: SetupSceneHost;

	constructor(host: SetupSceneHost) {
		this.#host = host;
		const { presets, items } = getGlyphItems();
		this.#presets = presets;
		this.#selectList = new SelectList(items, items.length, getSelectListTheme(), {
			wrapDescription: true,
			maxDescriptionRows: 1,
		});
		this.#originalPreset = theme.getSymbolPreset();
		const currentIndex = this.#presets.indexOf(this.#originalPreset);
		this.#selectList.setSelectedIndex(currentIndex >= 0 ? currentIndex : 0);
		this.#selectList.onSelectionChange = item => {
			this.#preview(item.value as SymbolPreset);
		};
		this.#selectList.onSelect = item => {
			void this.#commit(item.value as SymbolPreset);
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
		const quickIndex = data >= "1" && data <= String(this.#presets.length) ? Number(data) - 1 : -1;
		if (quickIndex >= 0 && quickIndex < this.#presets.length) {
			const preset = this.#presets[quickIndex];
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
				minContentLines: this.#presets.length,
				fitContent: () => {
					this.#selectList.setMaxVisible(this.#presets.length);
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
		this.#host.ctx.saveSymbolPreset(preset);
		await setSymbolPreset(preset);
		await this.#host.ctx.settings.flush();
		this.#host.ctx.ui.invalidate();
		this.#host.finish("done");
	}

	async #cancel(): Promise<void> {
		if (this.#committing) return;
		this.#committing = true;
		this.#previewRequest += 1;
		await this.#previewChain;
		await setSymbolPreset(this.#originalPreset);
		this.#host.ctx.ui.invalidate();
		this.#host.requestRender();
		this.#host.finish("skipped");
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
