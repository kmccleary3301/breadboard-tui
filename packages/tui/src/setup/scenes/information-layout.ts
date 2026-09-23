import { basename } from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { routeSelectListMouse, type SelectItem, SelectList, type SgrMouseEvent, visibleWidth } from "@oh-my-pi/pi-tui";
import { IS_BREADBOARD_PRODUCT } from "@oh-my-pi/pi-utils/dirs";
type StatusLinePreset =
	| "bb-balanced"
	| "bb-quiet"
	| "bb-detailed"
	| "default"
	| "minimal"
	| "compact"
	| "full"
	| "nerd"
	| "ascii"
	| "custom";
import type { ComposerShape } from "../../overlays/composer-shape-registry";
import { BreadboardCustomizeSubmenu } from "../../overlays/settings-selector";
import { renderComposerShapePreview, type ComposerPreviewStatusSource } from "../../overlays/composer-shape-preview";
import {
	renderBreadboardStatusLine,
	renderBreadboardStatusRows,
	type BreadboardStatusSnapshot,
} from "../../status-line/breadboard-presentation";
import type { BreadboardComposerActivity } from "../../status-line/types";
import type { BreadboardFieldSettings } from "../../status-line/breadboard-fields";
import { getSelectListTheme, theme } from "../../theme/theme";
import type { SetupScene, SetupSceneController, SetupSceneHost } from "./types";

export const PRESENTATION_PRESETS: readonly SelectItem[] = [
	{ value: "bb-balanced", label: "BreadBoard Balanced", description: "Folder, session, model, compact context and available spend" },
	{ value: "bb-quiet", label: "BreadBoard Quiet", description: "Folder and model, with activity and context pressure when needed" },
	{ value: "bb-detailed", label: "BreadBoard Detailed", description: "Identity, harness, token counts, available spend and timing" },
	{ value: "default", label: "Default", description: "Model, path, git, context, tokens, cost" },
	{ value: "minimal", label: "Minimal", description: "Path and git only" },
	{ value: "compact", label: "Compact", description: "Model, git, cost, context" },
	{ value: "full", label: "Full", description: "All segments including time" },
	{ value: "nerd", label: "Nerd", description: "Maximum info with Nerd Font icons" },
	{ value: "ascii", label: "ASCII", description: "No special characters" },
	{ value: "custom", label: "Custom", description: "User-defined segments" },
];
function isBreadboardPreset(value: string | undefined): value is StatusLinePreset {
	return value === "bb-balanced" || value === "bb-quiet" || value === "bb-detailed";
}
const BREADBOARD_PRESETS = PRESENTATION_PRESETS.filter(choice => choice.value.startsWith("bb-"));
const PREVIEW_ACTIVITIES: readonly (BreadboardComposerActivity | null)[] = [
	null,
	{ kind: "tool", label: "Running tests" },
	{ kind: "approval", label: "Approval required" },
];
const LEGACY_PRESETS = PRESENTATION_PRESETS.filter(choice => !isBreadboardPreset(choice.value));
const PRESENTATION_ITEMS: readonly SelectItem[] = [
	...BREADBOARD_PRESETS.map(choice => ({ ...choice })),
	{
		value: "__customize",
		label: "Customize…",
		description: "Choose each BreadBoard field with a live sample preview",
	},
	...LEGACY_PRESETS.map(choice => ({ ...choice })),
];

/** Deliberately sample state, labeled as such by the preview UI. No coding session is opened. */
export function previewSnapshot(host: SetupSceneHost): BreadboardStatusSnapshot {
	const model = host.ctx.modelSelection.currentModel;
	return {
		modelName: model?.name ?? model?.id ?? "Configured model",
		workspace: basename(process.cwd()),
		workspacePath: process.cwd(),
		sessionName: "Sample session",
		branch: "main",
		effort: ThinkingLevel.High,
		spend: { sessionUsd: 0.24, turnUsd: 0.03, estimated: true },
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
	fields?: BreadboardFieldSettings,
): ComposerPreviewStatusSource {
	const render = (width: number, layout: "box" | "band" | "plain-full" | "plain-left" | "plain-right") =>
		renderBreadboardStatusLine(snapshot, preset, width, layout, fields);
	const top = (width: number, layout: "box" | "band" | "plain-right") => {
		const rows = renderBreadboardStatusRows(snapshot, preset, width, layout, fields);
		return { content: rows.top, width: visibleWidth(rows.top) };
	};
	return {
		getTopBorder: width => top(width, "box"),
		getBandTopBorder: width => top(width, "band"),
		getStandaloneTopBorder: width => top(width, "plain-right"),
		renderBottomBar: (width, groups) => render(width, groups === "left" ? "plain-left" : "plain-full"),
		renderOverflowBar: (width, topWidth, layout) => {
			const bottom = renderBreadboardStatusRows(snapshot, preset, topWidth, layout, fields).bottom;
			return bottom ? " ".repeat(Math.max(0, Math.floor((width - topWidth) / 2))) + bottom : "";
		},
	};
}

class InformationLayoutSceneController implements SetupSceneController {
	readonly title = "Choose information layout";
	#selectList: SelectList;
	#currentPreset: StatusLinePreset;
	#committing = false;
	#listRowStart = 0;
	#customizer: BreadboardCustomizeSubmenu | null = null;
	#customizerRowStart = 0;
	#previewFields: BreadboardFieldSettings;
	#previewState = 0;
	readonly #snapshot: BreadboardStatusSnapshot;

	constructor(private readonly host: SetupSceneHost) {
		this.#snapshot = previewSnapshot(host);
		this.#currentPreset = host.ctx.settings.get<StatusLinePreset>("statusLine.preset");
		this.#previewFields = host.ctx.settings.get<BreadboardFieldSettings>("statusLine.breadboard");
		this.#selectList = new SelectList(PRESENTATION_ITEMS, 5, getSelectListTheme());
		this.#selectList.setSelectedIndex(
			Math.max(
				0,
				PRESENTATION_ITEMS.findIndex(choice => choice.value === this.#currentPreset),
			),
		);
		this.#selectList.onSelectionChange = item => {
			const choice = PRESENTATION_PRESETS.find(candidate => candidate.value === item.value);
			if (!choice) return;
			this.#currentPreset = choice.value as StatusLinePreset;
			this.host.requestRender();
		};
		this.#selectList.onSelect = item => {
			if (item.value === "__customize") {
				const saved = this.host.ctx.settings.get<StatusLinePreset>("statusLine.preset");
				this.#currentPreset = isBreadboardPreset(saved) ? saved : "bb-balanced";
				this.#openCustomizer();
				return;
			}
			const choice = PRESENTATION_PRESETS.find(candidate => candidate.value === item.value);
			if (choice) void this.#commit(choice.value as StatusLinePreset);
		};
		this.#selectList.onCancel = () => this.host.finish("skipped");
	}
	invalidate(): void {
		this.#selectList.invalidate();
		this.#customizer?.invalidate();
	}
	handleInput(data: string): void {
		if (this.#committing) return;
		if (data === " ") {
			this.#previewState = (this.#previewState + 1) % PREVIEW_ACTIVITIES.length;
			this.host.requestRender();
			return;
		}
		if (this.#customizer) this.#customizer.handleInput(data);
		else this.#selectList.handleInput(data);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (this.#customizer) {
			this.#customizer.routeMouse(event, line - this.#customizerRowStart, col);
			return;
		}
		if (!this.#committing) routeSelectListMouse(this.#selectList, event, line - this.#listRowStart);
	}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		if (this.#customizer) {
			const activity = PREVIEW_ACTIVITIES[this.#previewState] ?? null;
			const snapshot = { ...this.#snapshot, activity, elapsedMs: this.#previewState === 1 ? 8_000 : null };
			lines.push(theme.fg("dim", "Sample preview · Space switches idle / working / approval"), "");
			lines.push(
				...renderComposerShapePreview(
					this.host.ctx.settings.get<ComposerShape>("composer.shape") ?? "box",
					width,
					createBreadboardPreviewStatusSource(snapshot, this.#currentPreset, this.#previewFields),
				),
				"",
			);
			this.#customizerRowStart = lines.length;
			lines.push(...this.#customizer.render(width));
			return lines;
		}
		if (isBreadboardPreset(this.#currentPreset)) {
			const activity = PREVIEW_ACTIVITIES[this.#previewState] ?? null;
			const snapshot = { ...this.#snapshot, activity, elapsedMs: this.#previewState === 1 ? 8_000 : null };
			lines.push(theme.fg("dim", "Sample preview · Space switches idle / working / approval"), "");
			lines.push(
				...renderComposerShapePreview(
					this.host.ctx.settings.get<ComposerShape>("composer.shape") ?? "box",
					width,
					createBreadboardPreviewStatusSource(snapshot, this.#currentPreset, this.#previewFields),
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
	#openCustomizer(): void {
		this.#previewFields = this.host.ctx.settings.get<BreadboardFieldSettings>("statusLine.breadboard");
		const original = this.#previewFields;
		this.#customizer = new BreadboardCustomizeSubmenu(
			original,
			this.#currentPreset as ConstructorParameters<typeof BreadboardCustomizeSubmenu>[1],
			fields => {
				this.#previewFields = fields;
				this.host.requestRender();
			},
			fields => void this.#commitFields(fields),
			() => {
				this.#previewFields = original;
				this.#customizer = null;
				this.host.requestRender();
			},
		);
		this.host.requestRender();
	}

	async #commitFields(fields: BreadboardFieldSettings): Promise<void> {
		if (this.#committing) return;
		this.#committing = true;
		this.host.ctx.settings.set("statusLine.preset", this.#currentPreset);
		this.host.ctx.settings.set("statusLine.breadboard", fields);
		this.host.ctx.statusLine?.updateSettings?.({
			...this.host.ctx.settings.getGroup("statusLine"),
			breadboard: fields,
		});
		this.host.finish("done");
	}

	async #commit(preset: StatusLinePreset): Promise<void> {
		if (this.#committing) return;
		this.#committing = true;
		this.host.ctx.settings.set("statusLine.preset", preset);
		this.host.ctx.statusLine?.updateSettings?.(this.host.ctx.settings.getGroup("statusLine"));
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
