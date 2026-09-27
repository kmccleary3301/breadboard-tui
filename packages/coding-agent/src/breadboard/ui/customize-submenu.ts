import {
	Container,
	type Component,
	type SelectItem,
	SelectList,
	type SgrMouseEvent,
	Spacer,
	Text,
	getSelectListTheme,
	routeSelectListMouse,
	theme,
} from "@oh-my-pi/pi-tui";
import { type SelectFormField } from "@oh-my-pi/pi-tui/components/form";
import { createSettingsSelectField } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import type { StatusLinePreset } from "@oh-my-pi/pi-tui/status-line/types";
import {
	BREADBOARD_FIELD_DEFINITIONS,
	type BreadboardFieldKey,
	type BreadboardFieldSettings,
	DEFAULT_BREADBOARD_FIELD_SETTINGS,
	isBreadboardFieldKey,
	updateBreadboardField,
} from "./status-line/breadboard-fields";
import { isBreadboardPreset } from "./status-line/presets";

export class BreadboardCustomizeSubmenu extends Container {
	#selectList!: SelectList;
	#selectListLineOffset = 0;
	#editor: SelectFormField | null = null;
	#draft: BreadboardFieldSettings;
	readonly #original: BreadboardFieldSettings;

	constructor(
		initial: BreadboardFieldSettings,
		private readonly preset: StatusLinePreset | string,
		private readonly onPreview: (fields: BreadboardFieldSettings) => void,
		private readonly onApply: (fields: BreadboardFieldSettings) => void,
		private readonly onCancel: () => void,
		private readonly preview?: Component,
		private readonly requestRender?: () => void,
	) {
		super();
		this.#draft = { ...initial };
		this.#original = { ...initial };
		this.#showList();
	}

	showPresets(
		current: StatusLinePreset | string,
		onSelect: (preset: StatusLinePreset | string) => void,
		onPreview: (preset: StatusLinePreset | string) => void,
		onCancel: () => void,
		presets: ReadonlyArray<SelectItem>,
	): void {
		const choices: SelectItem[] = [
			...presets.filter(option => isBreadboardPreset(option.value as StatusLinePreset)),
			{
				value: "__customize",
				label: "Customize…",
				description: "Edit the current layout without changing shape or glyphs",
			},
			...presets.filter(option => !isBreadboardPreset(option.value as StatusLinePreset)),
		];
		this.clear();
		this.#editor = createSettingsSelectField(
			"Information layout",
			"Choose a preset or customize individual fields.",
			choices,
			current,
			value => {
				if (value === "__customize") {
					this.#previewDraft();
					this.#showList();
					return;
				}
				const choice = presets.find(option => option.value === value);
				if (choice) onSelect(choice.value as StatusLinePreset);
			},
			onCancel,
			value => {
				const choice = presets.find(option => option.value === value);
				onPreview((choice?.value ?? current) as StatusLinePreset);
			},
			undefined,
			this.preview,
			this.requestRender,
		);
		this.addChild(this.#editor);
		this.requestRender?.();
	}

	#items(): readonly SelectItem[] {
		const fields: SelectItem[] = BREADBOARD_FIELD_DEFINITIONS.map(definition => {
			const current = definition.options.find(option => option.value === this.#draft[definition.key]);
			return {
				value: definition.key,
				label: `${definition.label}: ${current?.label ?? "Preset"}`,
				description: current?.description,
			};
		});
		return [
			...fields,
			{
				value: "__reset",
				label: "Reset layout to selected preset",
				description: `Clear field overrides and follow ${this.preset.replace("bb-", "")}`,
			},
			{ value: "__apply", label: "Apply", description: "Save these fields and update the live status line" },
			{ value: "__cancel", label: "Cancel", description: "Discard staged field changes" },
		];
	}

	#showList(selectedValue?: string): void {
		this.#editor = null;
		this.clear();
		this.addChild(new Text(theme.bold(theme.fg("accent", "Customize BreadBoard information")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					"~ marks estimates. Unavailable accounting or effort stays hidden. Approval and error alerts stay visible.",
				),
				0,
				0,
			),
		);
		if (this.preview) {
			this.addChild(new Spacer(1));
			this.addChild(this.preview);
		}
		this.addChild(new Spacer(1));
		const items = this.#items();
		this.#selectList = new SelectList(items, Math.min(12, items.length), getSelectListTheme());
		const selectedIndex = selectedValue === undefined ? 0 : items.findIndex(item => item.value === selectedValue);
		if (selectedIndex >= 0) this.#selectList.setSelectedIndex(selectedIndex);
		this.#selectList.onSelect = item => {
			if (item.value === "__reset") {
				this.#draft = { ...DEFAULT_BREADBOARD_FIELD_SETTINGS };
				this.#previewDraft();
				this.#showList("__reset");
				return;
			}
			if (item.value === "__apply") {
				this.onApply(this.#draft);
				return;
			}
			if (item.value === "__cancel") {
				this.onPreview(this.#original);
				this.onCancel();
				return;
			}
			if (!isBreadboardFieldKey(item.value)) return;
			this.#openField(item.value);
		};
		this.#selectList.onCancel = () => {
			this.onPreview(this.#original);
			this.onCancel();
		};
		this.addChild(this.#selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to edit · Esc to cancel · ←/→ changes selected field"), 0, 0));
		this.requestRender?.();
	}

	#previewDraft(): void {
		this.onPreview(this.#draft);
		this.requestRender?.();
	}

	#openField(key: BreadboardFieldKey): void {
		const definition = BREADBOARD_FIELD_DEFINITIONS.find(candidate => candidate.key === key);
		if (!definition) return;
		this.clear();
		this.#editor = createSettingsSelectField(
			definition.label,
			"Choose Preset to follow the selected layout, or pin this field independently.",
			definition.options.map(option => ({
				value: option.value,
				label: option.label,
				description: option.description,
			})),
			String(this.#draft[key]),
			value => {
				const updated = updateBreadboardField(this.#draft, key, value);
				if (!updated) return;
				this.#draft = updated;
				this.#previewDraft();
				this.#showList(key);
			},
			() => {
				this.#previewDraft();
				this.#showList(key);
			},
			value => {
				const updated = updateBreadboardField(this.#draft, key, value);
				if (updated) this.onPreview(updated);
				this.requestRender?.();
			},
			undefined,
			this.preview,
			this.requestRender,
		);
		this.addChild(this.#editor);
		this.requestRender?.();
	}

	override render(width: number): readonly string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			const childLines = child.render(Math.max(1, width));
			if (child === this.#selectList) this.#selectListLineOffset = lines.length;
			lines.push(...childLines);
		}
		return lines;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (this.#editor) {
			this.#editor.routeMouse(event, line, col);
			return;
		}
		routeSelectListMouse(this.#selectList, event, line - this.#selectListLineOffset);
	}

	handleInput(data: string): void {
		if (this.#editor) {
			this.#editor.handleInput(data);
			return;
		}
		if ((data === "\x1b[D" || data === "\x1b[C") && this.#selectList.getSelectedItem()) {
			const selected = this.#selectList.getSelectedItem();
			if (
				selected &&
				selected.value !== "__reset" &&
				selected.value !== "__apply" &&
				selected.value !== "__cancel"
			) {
				const definition = BREADBOARD_FIELD_DEFINITIONS.find(candidate => candidate.key === selected.value);
				if (!definition) return;
				const currentIndex = definition.options.findIndex(option => option.value === this.#draft[definition.key]);
				const nextIndex =
					(currentIndex + (data === "\x1b[C" ? 1 : -1) + definition.options.length) % definition.options.length;
				const updated = updateBreadboardField(this.#draft, definition.key, definition.options[nextIndex]!.value);
				if (updated) {
					this.#draft = updated;
					this.#previewDraft();
					this.#showList(definition.key);
				}
				return;
			}
		}
		this.#selectList.handleInput(data);
	}
}
