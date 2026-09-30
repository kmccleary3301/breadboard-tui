import type { AuthStorage, Model } from "@oh-my-pi/pi-ai";
import type { OAuthBrowserSessionRequest } from "@oh-my-pi/pi-ai/oauth/types";
import type { SgrMouseEvent } from "../../mouse";
import type { ComposerPreviewStatusSource } from "../../overlays/composer-shape-preview";
import type { ComposerShape } from "../../overlays/composer-shape-registry";
import type { ModelBrowserSource } from "../../overlays/model-browser";
import type { SymbolPreset, ThemeColor } from "../../theme/theme";
import type { Component, TUI } from "../../tui";
import type { ProductIdentity } from "../../product-identity";

/** One line of status copy kept as raw text plus its theme colour, never as pre-styled ANSI. */
export interface StyledLine {
	readonly text: string;
	readonly color: ThemeColor;
}

/** Terminal capabilities used by setup overlays and the startup splash. */
export interface SetupUiHost {
	readonly identity?: ProductIdentity;
	readonly ui: Pick<TUI, "showOverlay" | "setFocus" | "requestRender" | "invalidate"> & {
		readonly terminal: { readonly rows: number; readonly columns?: number };
	};
}

export interface SetupSettingsHost {
	get<T = unknown>(key: string): T;
	set(key: string, value: unknown): void;
	getGroup(group: string): Record<string, unknown>;
	flush(): Promise<void>;
}

export interface SetupModelSelection {
	/** `session` switches only the running session's model; `default` persists the default role. */
	readonly mode?: "default" | "session";
	readonly currentModel: Model | undefined;
}
/** Application-owned preferences and effects consumed by setup scenes. */
export interface SetupHost extends SetupUiHost {
	readonly settings: SetupSettingsHost;
	readonly modelSelection: SetupModelSelection;
	readonly statusLine:
		| (ComposerPreviewStatusSource & { updateSettings?: (settings: Record<string, unknown>) => void })
		| undefined;
	readonly composerShape: ComposerShape;
	readonly symbolPreset: SymbolPreset;
	readonly colorBlindMode: boolean;
	readonly disabledProviders: readonly string[];
	readonly authStorage: AuthStorage;
	readonly modelSource: ModelBrowserSource;
	getModels(): { available: Model[]; all: Model[]; current: Model | undefined };
	refreshModels(): Promise<void>;
	selectModel(model: Model, selector: string): Promise<void>;
	refreshProvider(provider: string): Promise<void>;
	saveComposerShape(shape: ComposerShape): Promise<void>;
	saveSymbolPreset(preset: SymbolPreset): void;
	saveColorBlindMode(enabled: boolean): void;
	saveTheme(mode: "dark" | "light", name: string): void;
	captureBrowserSession(request: OAuthBrowserSessionRequest, signal?: AbortSignal): Promise<string>;
	copyToClipboard(text: string): Promise<void>;
	openInBrowser(url: string): void;
	markComplete(version: number): Promise<void>;
	playWelcomeIntro(): void;
	showError(message: string): void;
}

/** Outcome reported when an onboarding scene finishes. */
export type SetupSceneResult = "done" | "skipped";

/** Per-scene focus, rendering, completion, and application callbacks. */
export interface SetupSceneHost {
	ctx: SetupHost;
	requestRender(): void;
	finish(result: SetupSceneResult): void;
	setFocus(component: Component | null): void;
	restoreFocus(): void;
}

/** Interactive content hosted inside the setup wizard frame. */
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

/** Versioned onboarding scene definition. */
export interface SetupScene {
	id: string;
	title: string;
	minVersion: number;
	shouldRun?(ctx: SetupHost): boolean | Promise<boolean>;
	mount(host: SetupSceneHost): SetupSceneController;
}
