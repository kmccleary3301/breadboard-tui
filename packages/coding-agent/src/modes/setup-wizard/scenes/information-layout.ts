import { basename } from "node:path";
import { routeSelectListMouse, type SelectItem, SelectList, type SgrMouseEvent, visibleWidth } from "@oh-my-pi/pi-tui";
import { IS_BREADBOARD_PRODUCT } from "@oh-my-pi/pi-utils/dirs";
import { SETTINGS_SCHEMA, type StatusLinePreset } from "../../../config/settings-schema";
import { renderComposerShapePreview, type ComposerPreviewStatusSource } from "../../components/composer-shape-preview";
import {
	isBreadboardPreset,
	renderBreadboardStatusLine,
	type BreadboardStatusSnapshot,
} from "../../components/status-line/breadboard-presentation";
import type { BreadboardComposerActivity } from "../../components/status-line/types";
import { getSelectListTheme, theme } from "../../theme/theme";
import type { SetupScene, SetupSceneController, SetupSceneHost } from "./types";

export const PRESENTATION_PRESETS = SETTINGS_SCHEMA["statusLine.preset"].ui.options;
const PRESENTATION_ITEMS: readonly SelectItem[] = PRESENTATION_PRESETS.map(choice => ({ ...choice }));
const PREVIEW_ACTIVITIES: readonly (BreadboardComposerActivity | null)[] = [
	null,
	{ kind: "tool", label: "Running tests" },
	{ kind: "approval", label: "Approval required" },
];

/** Deliberately sample state, labeled as such by the preview UI. No coding session is opened. */
export function previewSnapshot(host: SetupSceneHost): BreadboardStatusSnapshot {
	const model = host.ctx.modelSelection.currentModel;
	return {
		modelName: model?.name ?? model?.id ?? "Configured model",
		workspace: basename(process.cwd()),
		branch: "main",
		harness: {
			harnessId: "preview",
			name: "Daily driver",
			lockHash: null,
			generation: "preview1",
			mode: "coding",
			lock: null,
			provenance: {},
			loadedAt: 0,
		},
		context: { tokens: 12_000, capacity: model?.contextWindow ?? 100_000 },
		inputTokens: 12_000,
		outputTokens: 240,
	};
}

/** Both setup and the real composer use the same status formatter and composer chrome. */
export function createBreadboardPreviewStatusSource(
	snapshot: BreadboardStatusSnapshot,
	preset: StatusLinePreset,
): ComposerPreviewStatusSource {
	const render = (width: number, layout: "box" | "band" | "plain-full" | "plain-left" | "plain-right") =>
		renderBreadboardStatusLine(snapshot, preset, width, layout);
	const top = (width: number, layout: "box" | "band" | "plain-right") => {
		const content = render(width, layout);
		return { content, width: visibleWidth(content) };
	};
	return {
		getTopBorder: width => top(width, "box"),
		getBandTopBorder: width => top(width, "band"),
		getStandaloneTopBorder: width => top(width, "plain-right"),
		renderBottomBar: (width, groups) => render(width, groups === "left" ? "plain-left" : "plain-full"),
	};
}

class InformationLayoutSceneController implements SetupSceneController {
	title = "Choose information layout";
	subtitle = "Balanced keeps the essentials. Shape and glyphs are chosen separately.";
	#selectList: SelectList;
	#currentPreset: StatusLinePreset;
	#committing = false;
	#listRowStart = 0;
	#previewState = 0;
	readonly #snapshot: BreadboardStatusSnapshot;

	constructor(private readonly host: SetupSceneHost) {
		this.#snapshot = previewSnapshot(host);
		this.#currentPreset = host.ctx.settings.get("statusLine.preset");
		this.#selectList = new SelectList(PRESENTATION_ITEMS, 5, getSelectListTheme());
		this.#selectList.setSelectedIndex(
			Math.max(
				0,
				PRESENTATION_PRESETS.findIndex(choice => choice.value === this.#currentPreset),
			),
		);
		this.#selectList.onSelectionChange = item => {
			const choice = PRESENTATION_PRESETS.find(candidate => candidate.value === item.value);
			if (!choice) return;
			this.#currentPreset = choice.value;
			this.host.requestRender();
		};
		this.#selectList.onSelect = item => {
			const choice = PRESENTATION_PRESETS.find(candidate => candidate.value === item.value);
			if (choice) void this.#commit(choice.value);
		};
		this.#selectList.onCancel = () => this.host.finish("skipped");
	}

	invalidate(): void {
		this.#selectList.invalidate();
	}

	handleInput(data: string): void {
		if (this.#committing) return;
		if (data === " ") {
			this.#previewState = (this.#previewState + 1) % PREVIEW_ACTIVITIES.length;
			this.host.requestRender();
			return;
		}
		this.#selectList.handleInput(data);
	}

	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		if (!this.#committing) routeSelectListMouse(this.#selectList, event, line - this.#listRowStart);
	}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		if (isBreadboardPreset(this.#currentPreset)) {
			const activity = PREVIEW_ACTIVITIES[this.#previewState] ?? null;
			const snapshot = { ...this.#snapshot, activity, elapsedMs: this.#previewState === 1 ? 8_000 : null };
			lines.push(theme.fg("dim", "Sample preview · Space switches idle / working / approval"), "");
			lines.push(
				...renderComposerShapePreview(
					this.host.ctx.settings.get("composer.shape") ?? "box",
					width,
					createBreadboardPreviewStatusSource(snapshot, this.#currentPreset),
				),
				"",
			);
		} else {
			lines.push(theme.fg("dim", "Existing layout · configure and preview in /settings"), "");
		}
		this.#listRowStart = lines.length;
		lines.push(...this.#selectList.render(width));
		return lines;
	}

	async #commit(preset: StatusLinePreset): Promise<void> {
		if (this.#committing) return;
		this.#committing = true;
		this.host.ctx.settings.set("statusLine.preset", preset);
		await this.host.ctx.settings.flush();
		this.host.ctx.statusLine?.updateSettings(this.host.ctx.settings.getGroup("statusLine"));
		this.host.finish("done");
	}
}

export const informationLayoutSetupScene: SetupScene = {
	id: "information-layout",
	title: "Choose information layout",
	minVersion: 1,
	shouldRun: () => IS_BREADBOARD_PRODUCT,
	mount: host => new InformationLayoutSceneController(host),
};
