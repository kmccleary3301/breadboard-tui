import type { Model } from "@oh-my-pi/pi-ai";
import type { SgrMouseEvent } from "../../mouse";
import { Text } from "../../components/text";
import { WizardStep } from "../../components/wizard-step";
import { buildBrowserItems, ModelBrowser, resolveRoleAssignments, sortModelItems } from "../../overlays/model-browser";
import { BROWSER_FRAME_ROWS } from "../../overlays/model-picker";
import { theme } from "../../theme/theme";
import type { SetupScene, SetupSceneController, SetupSceneHost } from "./types";

const MAX_VISIBLE_MODELS = 10;

class ModelSceneController implements SetupSceneController {
	get title(): string {
		return this.host.ctx.modelSelection.mode === "session" ? "Choose your engine model" : "Choose your default model";
	}
	get subtitle(): string {
		return this.host.ctx.modelSelection.mode === "session"
			? "Select the model for this BreadBoard session."
			: "Search configured models and save the model used for new sessions.";
	}
	#browser: ModelBrowser;
	#status: string | undefined;
	#selecting = false;
	#disposed = false;
	#step: WizardStep | undefined;

	constructor(private readonly host: SetupSceneHost) {
		this.#browser = new ModelBrowser(host.ctx.settings, {
			emptyText: () => host.identity.setupModelEmptyText,
		});
		this.#browser.onActivate = item => {
			void this.#select(item.model, item.selector);
		};
		this.#browser.onCancel = () => host.finish("skipped");
		this.#syncModels();
	}

	async onMount(): Promise<void> {
		this.#status = theme.fg("muted", "Discovering available models…");
		this.#host.requestRender();
		await this.#refreshModels();
	}

	dispose(): void {
		this.#disposed = true;
	}

	invalidate(): void {
		if (this.#step) this.#step.invalidate();
		else this.#browser.invalidate();
	}

	handleInput(data: string): void {
		if (this.#selecting) return;
		if (this.#step) this.#step.handleInput(data);
		else this.#browser.handleInput(data);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (this.#selecting) return;
		this.#step?.routeMouse(event, line, col);
	}

	render(width: number, maxLines?: number): readonly string[] {
		const lines = [
			this.#status ??
				theme.fg(
					"muted",
					this.host.ctx.modelSelection.mode === "session"
						? "Type to search. Enter selects the highlighted engine model."
						: "Type to search. Enter saves the highlighted model as your default.",
				),
			"",
		];
		const budget = maxLines === undefined ? MAX_VISIBLE_MODELS : maxLines - lines.length - BROWSER_FRAME_ROWS;
		this.#browser.setMaxVisible(Math.max(1, Math.min(MAX_VISIBLE_MODELS, budget)));
		this.#browserRowStart = lines.length;
		lines.push(...this.#browser.render(width));
		return lines;
	}

	#syncModels(): void {
		const registry = this.host.ctx.modelRegistry;
		const external = this.host.ctx.modelSelection.mode === "session";
		const available = this.host.ctx.modelSelection.availableModels();
		const roles = external ? {} : resolveRoleAssignments(this.host.ctx.settings, registry.getAll(), available);
		const storage = this.host.ctx.settings.getStorage();
		const items = buildBrowserItems(available);
		sortModelItems(items, { roles, mruOrder: source.mruOrder });
		this.#browser.setRoles(roles);
		this.#browser.setMruOrder(source.mruOrder);
		this.#browser.setPerfStats(source.modelPerf);
		this.#browser.setItems(items);

		const current = this.host.ctx.modelSelection.currentModel;
		if (current) {
			const selector = `${current.provider}/${current.id}`;
			this.#browser.setCurrentSelector(selector);
			this.#browser.selectSelector(selector);
		}
	}

	async #refreshModels(): Promise<void> {
		try {
			await this.host.ctx.modelSelection.refresh();
			if (this.#disposed) return;
			this.#syncModels();
			this.#status = undefined;
			this.#host.requestRender();
		} catch (error) {
			if (this.#disposed) return;
			this.#status = theme.fg("error", error instanceof Error ? error.message : String(error));
			this.#host.requestRender();
		}
	}

	async #select(model: Model, selector: string): Promise<void> {
		if (this.#selecting) return;
		this.#selecting = true;
		this.#status = theme.fg(
			"muted",
			this.host.ctx.modelSelection.mode === "session"
				? `Selecting ${selector} for this engine session…`
				: `Saving ${selector} as the default model…`,
		);
		this.host.requestRender();
		try {
			await this.host.ctx.modelSelection.select(model, selector);
			if (!this.#disposed) this.host.finish("done");
		} catch (error) {
			if (this.#disposed) return;
			this.#selecting = false;
			this.#status = theme.fg("error", error instanceof Error ? error.message : String(error));
			this.#host.requestRender();
		}
	}
}

/** Setup step for the active engine model or the native persisted default role. */
export const modelSetupScene: SetupScene = {
	id: "model",
	title: "Choose your model",
	minVersion: 1,
	mount: host => new ModelSceneController(host),
};
