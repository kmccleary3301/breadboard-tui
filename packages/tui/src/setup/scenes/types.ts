import type { AuthStorage, Model } from "@oh-my-pi/pi-ai";
import type { Component, SgrMouseEvent, TUI } from "../../tui";
import type { ProviderAuthPort } from "../../breadboard/provider-auth-port";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { ProductIdentity } from "../../product-identity";
import type { ComposerPreviewStatusSource } from "../../overlays/composer-shape-preview";
import type { StatusLineComponent } from "../../status-line";

export interface SetupModelSelection {
	readonly mode: "default" | "session";
	readonly currentModel: Model | undefined;
	availableModels(): readonly Model[];
	refresh(): Promise<void>;
	select(model: Model, selector: string): Promise<void>;
}

/**
 * The setup wizard only needs terminal/UI, settings, catalog, and browser
 * access. Keeping these dependencies separate from InteractiveMode prevents
 * configuration-only setup from requiring a coding session.
 */
export interface SetupWizardContext {
	readonly ui: TUI;
	readonly settings: Settings;
	readonly modelRegistry: Pick<
		ModelRegistry,
		"authStorage" | "getAvailable" | "getAll" | "refresh" | "refreshProvider"
	>;
	readonly modelSelection: SetupModelSelection;
	readonly statusLine?: ComposerPreviewStatusSource & Pick<StatusLineComponent, "updateSettings">;
	openInBrowser(urlOrPath: string): void;
	playWelcomeIntro?(): void;
}

export type SetupSceneResult = "done" | "skipped";

export interface SetupSceneHost {
	readonly ctx: SetupWizardContext;
	readonly identity: ProductIdentity;
	readonly providerAuthPort?: ProviderAuthPort;
	readonly nativeAuthStorage?: AuthStorage;
	requestRender(): void;
	finish(result: SetupSceneResult): void;
	setFocus(component: Component | null): void;
	restoreFocus(): void;
}

export interface SetupSceneController extends Component {
	title: string;
	subtitle?: string;
	onMount?(): void | Promise<void>;
	onUnmount?(): void;
	dispose?(): void;
	render(width: number, maxLines?: number): readonly string[];
	routeMouse?(event: SgrMouseEvent, line: number, col: number): void;
}

export interface SetupTab {
	readonly id: string;
	readonly label: string;
	readonly modal: boolean;
	render(width: number, maxLines?: number): readonly string[];
	handleInput(data: string): void;
	invalidate(): void;
	onActivate?(): void;
	routeMouse?(event: SgrMouseEvent, line: number, col: number): void;
	dispose(): void;
}

export interface SetupScene {
	id: string;
	title: string;
	minVersion: number;
	shouldRun?(ctx: SetupWizardContext): boolean | Promise<boolean>;
	mount(host: SetupSceneHost): SetupSceneController;
}
