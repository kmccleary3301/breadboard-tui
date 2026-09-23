import { routeSelectListMouse, type SelectItem, SelectList, type SgrMouseEvent } from "@oh-my-pi/pi-tui";
import type { ComposerShape } from "../../../config/settings-schema";
import { renderComposerShapePreview, type ComposerPreviewStatusSource } from "../../overlays/composer-shape-preview";
import { getComposerShapeOptions } from "../../overlays/composer-shape-registry";
import { isBreadboardPreset } from "../../status-line/breadboard-presentation";
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
	#listRowStart = 0;
	#previewStatus?: ComposerPreviewStatusSource;

	constructor(private readonly host: SetupSceneHost) {
		const choices = getComposerShapeOptions(host.identity);
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
		const configuredPreset = host.ctx.settings.get("statusLine.preset");
		this.#previewStatus =
			host.ctx.statusLine ??
			(host.identity.id === "breadboard" && isBreadboardPreset(configuredPreset)
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
		const budget = maxLines ?? Number.POSITIVE_INFINITY;
		const lines = [theme.fg("muted", "Select a layout; live preview updates below. Press Enter to confirm."), ""];

		const previewLines = renderComposerShapePreview(
			this.#currentShape,
			width,
			this.#previewStatus,
			this.host.identity.cliName,
		);
		if (budget - lines.length - previewLines.length - 2 >= this.#items.length) {
			lines.push(theme.fg("muted", "Preview:"), ...previewLines, "");
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
