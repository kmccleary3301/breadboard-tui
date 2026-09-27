import { isReducedMotionEnabled } from "../reduced-motion";
import { CURRENT_SETUP_VERSION } from "./setup-version";
import type { SetupHost } from "./scenes/types";
import { composerSetupScene } from "./scenes/composer";
import { glyphSetupScene } from "./scenes/glyph";
import { modelSetupScene } from "./scenes/model";
import { providersSetupScene } from "./scenes/providers";
import { themeSetupScene } from "./scenes/theme";
import type { SetupScene } from "./scenes/types";
import { SetupWizardComponent } from "./wizard-overlay";

export { runStartupSplash } from "./startup-splash";
export { CURRENT_SETUP_VERSION };

/** Upstream built-in onboarding scenes. */
export const BUILTIN_SETUP_SCENES: readonly SetupScene[] = [
	providersSetupScene,
	modelSetupScene,
	glyphSetupScene,
	composerSetupScene,
	themeSetupScene,
];

interface RegisteredSetupScene {
	scene: SetupScene;
	options?: { before?: string; after?: string };
}

const registeredScenes: RegisteredSetupScene[] = [];
const sceneList: SetupScene[] = [...BUILTIN_SETUP_SCENES];

function rebuildScenes(): void {
	sceneList.length = 0;
	sceneList.push(...BUILTIN_SETUP_SCENES);
	for (const reg of registeredScenes) {
		let insertIndex = sceneList.length;
		if (reg.options?.before) {
			const idx = sceneList.findIndex(s => s.id === reg.options!.before);
			if (idx >= 0) insertIndex = idx;
		} else if (reg.options?.after) {
			const idx = sceneList.findIndex(s => s.id === reg.options!.after);
			if (idx >= 0) insertIndex = idx + 1;
		}
		sceneList.splice(insertIndex, 0, reg.scene);
	}
}

export function registerSetupScene(
	scene: SetupScene,
	options?: { before?: string; after?: string },
): () => void {
	const entry: RegisteredSetupScene = { scene, options };
	registeredScenes.push(entry);
	rebuildScenes();
	return () => {
		const idx = registeredScenes.indexOf(entry);
		if (idx >= 0) {
			registeredScenes.splice(idx, 1);
			rebuildScenes();
		}
	};
}

export function resetSetupScenes(): void {
	registeredScenes.length = 0;
	rebuildScenes();
}

export function getSetupScenes(): readonly SetupScene[] {
	return [...sceneList];
}

/** Ordered onboarding scenes with independent version gates. */
export const ALL_SCENES: readonly SetupScene[] = sceneList;

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
	ctx?: SetupHost,
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
}

/** Own the fullscreen setup overlay until its scenes and outro finish. */
export async function runSetupWizard(
	ctx: SetupHost,
	scenes: readonly SetupScene[] = ALL_SCENES,
	options: RunSetupWizardOptions = {},
): Promise<void> {
	if (scenes.length === 0) return;
	const component = new SetupWizardComponent(ctx, scenes, { reduceMotion: isReducedMotionEnabled() });
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
		ctx.playWelcomeIntro();
	}
}
