import { type SgrMouseEvent } from "../../mouse";
import { type SelectItem, SelectList } from "../../components/select-list";
import { Container } from "../../tui";
import { Text } from "../../components/text";
import { WizardStep } from "../../components/wizard-step";
import type { ComposerShape } from "../../overlays/composer-shape-registry";
import { type ComposerPreviewStatusSource, renderComposerShapePreview } from "../../overlays/composer-shape-preview";
import { getComposerShapeOptions } from "../../overlays/composer-shape-registry";
import { getProductIdentity, type ProductIdentity } from "../../product-identity";
import { isBreadboardPreset } from "../../status-line/breadboard-presentation";
import type { StatusLinePreset } from "../../status-line/types";
import { getSelectListTheme, theme } from "../../theme/theme";
import { createBreadboardPreviewStatusSource, previewSnapshot } from "./information-layout";
import type { SetupScene, SetupSceneController, SetupSceneHost } from "./types";

class ComposerSceneController implements SetupSceneController {
	title = "Choose composer shape";
	subtitle = "Pick the prompt and status line layout for your workflow.";
	#selectList: SelectList;
	#shapes: readonly ComposerShape[];
	#items: readonly SelectItem[];
	#currentShape: ComposerShape = "band";
	#committing = false;
	#step: WizardStep | undefined;
	readonly #identity: ProductIdentity;
	readonly #previewStatus: ComposerPreviewStatusSource | undefined;

	readonly #host: SetupSceneHost;

	constructor(host: SetupSceneHost) {
		this.#host = host;
		this.#identity = host.ctx.identity ?? getProductIdentity();
		const choices = getComposerShapeOptions(this.#identity);
		this.#shapes = choices.map(choice => choice.value);
		this.#items = choices.map((choice, index) => ({
			value: choice.value,
			label: `${index + 1}  ${choice.label}`,
			description: choice.description,
		}));
		const configuredShape = host.ctx.composerShape ?? "band";
		const initialShape = this.#shapes.includes(configuredShape) ? configuredShape : "band";
		this.#currentShape = initialShape;
		const initialIndex = Math.max(0, this.#shapes.indexOf(initialShape));
		// Without a live session status line, BreadBoard presets preview through a synthetic snapshot.
		const configuredPreset = host.ctx.settings.get<StatusLinePreset | undefined>("statusLine.preset");
		this.#previewStatus =
			host.ctx.statusLine ??
			(this.#identity.id === "breadboard" && isBreadboardPreset(configuredPreset) && configuredPreset
				? createBreadboardPreviewStatusSource(previewSnapshot(host), configuredPreset)
				: undefined);

		const selectListTheme = getSelectListTheme();
		this.#selectList = new SelectList(this.#items, this.#items.length, selectListTheme);
		this.#selectList.setSelectedIndex(initialIndex);
		this.#selectList.onSelectionChange = item => {
			this.#preview(item.value);
		};
		this.#selectList.onSelect = item => {
			void this.#commit(item.value);
		};
		this.#selectList.onCancel = () => {
			// Esc skips the scene without saving; the configured shape stays untouched.
			this.#host.finish("skipped");
		};
	}

	invalidate(): void {
		if (this.#step) this.#step.invalidate();
		else this.#selectList.invalidate();
	}

	handleInput(data: string): void {
		if (this.#committing) return;
		const quickIndex = data.length === 1 ? Number(data) - 1 : -1;
		if (Number.isInteger(quickIndex) && quickIndex >= 0 && quickIndex < this.#items.length) {
			this.#selectList.setSelectedIndex(quickIndex);
			this.#preview(this.#shapes[quickIndex] ?? "band");
			return;
		}
		if (this.#step) this.#step.handleInput(data);
		else this.#selectList.handleInput(data);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		this.#step?.routeMouse(event, line, col);
	}

	render(width: number, maxLines?: number): readonly string[] {
		const intro = new Text(
			theme.fg("muted", "Select a layout; live preview updates below. Press Enter to confirm."),
			0,
			0,
		);
		const preview = new Container();
		preview.addChild(new Text(theme.fg("muted", "Preview:"), 0, 0));
		for (const line of renderComposerShapePreview(
			this.#currentShape,
			width,
			this.#previewStatus,
			this.#identity.cliName,
		)) {
			preview.addChild(new Text(line, 0, 0));
		}
		const items = this.#items.length;
		if (!this.#step) {
			this.#step = new WizardStep({
				kind: "choice",
				intro,
				preview: { component: preview, optional: true },
				content: this.#selectList,
				minContentLines: items,
				fitContent: () => {
					this.#selectList.setMaxVisible(items);
				},
			});
		} else {
			this.#step.setIntro(intro);
			this.#step.setPreview({ component: preview, optional: true });
		}
		this.#step.setMaxHeight(maxLines);
		return this.#step.render(width);
	}

	async #commit(shape: ComposerShape): Promise<void> {
		if (this.#committing) return;
		this.#committing = true;
		try {
			await this.#host.ctx.saveComposerShape(shape);
		} finally {
			this.#host.finish("done");
		}
	}

	#preview(shape: ComposerShape): void {
		this.#currentShape = shape;
		this.#host.requestRender();
	}
}

/** Select and persist the prompt composer layout. */
export const composerSetupScene: SetupScene = {
	id: "composer-shape",
	title: "Choose composer shape",
	minVersion: 2,
	mount: host => new ComposerSceneController(host),
};
