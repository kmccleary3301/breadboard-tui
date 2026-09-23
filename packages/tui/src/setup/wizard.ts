import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { ProviderAuthPort } from "../../breadboard/provider-auth-port";
import type { Settings } from "../../config/settings";
import { ACTIVE_PRODUCT_IDENTITY, type ProductIdentity } from "../../product-identity";
import { CURRENT_SETUP_VERSION } from "../setup-version";
import type { InteractiveModeContext } from "../types";
import { composerSetupScene } from "./scenes/composer";
import { glyphSetupScene } from "./scenes/glyph";
import { informationLayoutSetupScene } from "./scenes/information-layout";
import { modelSetupScene } from "./scenes/model";
import { providersSetupScene } from "./scenes/providers";
import { themeSetupScene } from "./scenes/theme";
import type { SetupScene, SetupWizardContext } from "./scenes/types";
import { SetupWizardComponent } from "./wizard-overlay";

export type {
	SetupScene,
	SetupSceneController,
	SetupSceneHost,
	SetupSceneResult,
	SetupWizardContext,
} from "./scenes/types";

export { runStartupSplash } from "./startup-splash";
export { CURRENT_SETUP_VERSION };

export const ALL_SCENES = [
	providersSetupScene,
	modelSetupScene,
	informationLayoutSetupScene,
	glyphSetupScene,
	composerSetupScene,
	themeSetupScene,
] as const satisfies readonly SetupScene[];

/** Environment and invocation gates for onboarding scene selection. */
export interface SetupSceneSelectionOptions {
	resuming?: boolean;
	isTTY?: boolean;
	skipEnv?: string;
	setupWizardEnabled?: boolean;
	force?: boolean;
}

function setupSkipEnvEnabled(value: string | undefined): boolean {
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

/** Select scenes newer than the stored version, honoring hard environment gates. */
export async function selectSetupScenes(
	storedVersion: number,
	scenes: readonly SetupScene[],
	ctx?: SetupWizardContext,
	options: SetupSceneSelectionOptions = {},
): Promise<SetupScene[]> {
	const isTTY = options.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY);
	if (!isTTY) return [];
	if (!options.force) {
		if (options.resuming) return [];
		if (setupSkipEnvEnabled(options.skipEnv ?? Bun.env.OMP_SKIP_SETUP)) return [];
		if (options.setupWizardEnabled === false) return [];
	}

	const selected: SetupScene[] = [];
	for (const scene of scenes) {
		if (!options.force && scene.minVersion <= storedVersion) continue;
		if (scene.shouldRun) {
			if (!ctx) continue;
			if (!(await scene.shouldRun(ctx))) continue;
		}
		selected.push(scene);
	}
	return selected;
}

/** Control completion persistence and the post-setup welcome animation. */
export interface RunSetupWizardOptions {
	markComplete?: boolean;
	playWelcomeIntro?: boolean;
	providerAuthPort?: ProviderAuthPort;
	nativeAuthStorage?: AuthStorage;
	identity?: ProductIdentity;
	now?: () => number;
}
/**
 * Adapt the live interactive session to the setup-only dependency surface.
 * Setup scenes never need the rest of InteractiveMode, while ordinary in-session
 * setup keeps its existing engine/native model-selection behavior.
 */
export function createInteractiveSetupContext(ctx: InteractiveModeContext): SetupWizardContext {
	const engineOwned = ctx.session.mainStreamOwnsTurnLifecycle;
	return {
		ui: ctx.ui,
		settings: ctx.settings,
		modelRegistry: ctx.session.modelRegistry,
		modelSelection: {
			mode: engineOwned ? "session" : "default",
			get currentModel() {
				return ctx.session.model;
			},
			availableModels: () =>
				engineOwned ? ctx.session.scopedModels.map(entry => entry.model) : ctx.session.modelRegistry.getAvailable(),
			refresh: engineOwned ? async () => {} : () => ctx.session.modelRegistry.refresh("online-if-uncached"),
			select: async (model, selector) => {
				if (engineOwned) {
					await ctx.session.setModelTemporary(model);
					return;
				}
				const projectScope = ctx.settings.get("modelRoleStorage") === "project";
				await ctx.session.setModel(model, "default", { selector, persist: !projectScope });
				if (projectScope) ctx.settings.setProjectModelRole("default", selector);
				await ctx.settings.flush();
			},
		},
		statusLine: ctx.statusLine,
		openInBrowser: ctx.openInBrowser.bind(ctx),
		playWelcomeIntro: ctx.playWelcomeIntro.bind(ctx),
	};
}

/** Own the fullscreen setup overlay until its scenes and outro finish. */
export async function runSetupWizard(
	ctx: SetupWizardContext,
	scenes: readonly SetupScene[] = ALL_SCENES,
	options: RunSetupWizardOptions = {},
): Promise<void> {
	if (scenes.length === 0) return;
	const component = new SetupWizardComponent(ctx, scenes, {
		identity: options.identity ?? ACTIVE_PRODUCT_IDENTITY,
		...(options.providerAuthPort ? { providerAuthPort: options.providerAuthPort } : {}),
		nativeAuthStorage: options.nativeAuthStorage,
		...(options.now ? { now: options.now } : {}),
	});
	const overlay = ctx.ui.showOverlay(component, {
		width: "100%",
		maxHeight: "100%",
		anchor: "top-left",
		margin: 0,
		fullscreen: true,
	});
	try {
		await component.run();
		if (options.markComplete !== false) {
			await ctx.markComplete(CURRENT_SETUP_VERSION);
		}
	} finally {
		component.dispose();
		ctx.ui.setFocus(component);
		overlay.hide();
	}
	if (options.playWelcomeIntro !== false) {
		ctx.playWelcomeIntro?.();
	}
}
