import type { AuthStorage, Model } from "@oh-my-pi/pi-ai";
import type { Component, SgrMouseEvent, TUI } from "@oh-my-pi/pi-tui";
import type { ProviderAuthPort } from "../../../breadboard/provider-auth-port";
import type { ModelRegistry } from "../../../config/model-registry";
import type { Settings } from "../../../config/settings";
import type { ProductIdentity } from "../../../product-identity";
import type { ComposerPreviewStatusSource } from "../../components/composer-shape-preview";

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
	readonly statusLine?: ComposerPreviewStatusSource;
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
	/**
	 * Render the scene body. `maxLines` is the number of body rows the wizard
	 * will actually display (header and footer already subtracted); scenes
	 * shrink list windows and drop decorative chrome so the selected row stays
	 * inside the budget. Overflow beyond `maxLines` is clipped by the wizard.
	 */
	render(width: number, maxLines?: number): readonly string[];
	/**
	 * Route an SGR mouse report (tracking is on while the wizard holds the
	 * alternate screen). `line`/`col` are 0-based within this controller's
	 * last rendered output. When absent, the wizard falls back to synthesizing
	 * arrow keys from wheel notches.
	 */
	routeMouse?(event: SgrMouseEvent, line: number, col: number): void;
}

/**
 * A single panel inside a tabbed setup scene. The host scene owns the tab bar
 * and forwards rendering/input to the active tab.
 */
export interface SetupTab {
	readonly id: string;
	readonly label: string;
	/**
	 * While `true` the tab owns all keyboard input (e.g. an in-progress OAuth
	 * login). The parent scene MUST NOT switch tabs or finish while modal.
	 */
	readonly modal: boolean;
	/** See {@link SetupSceneController.render}: `maxLines` is the tab-local row budget. */
	render(width: number, maxLines?: number): readonly string[];
	handleInput(data: string): void;
	invalidate(): void;
	/** Called when the tab becomes active (including initial mount). */
	onActivate?(): void;
	/** Mouse routing at tab-local coordinates; see {@link SetupSceneController.routeMouse}. */
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
