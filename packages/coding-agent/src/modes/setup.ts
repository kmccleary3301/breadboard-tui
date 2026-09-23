import type { WebSearchGrounding } from "@oh-my-pi/pi-catalog/types";
import { runProviderSetupWizard as runProviderWizard } from "@oh-my-pi/pi-tui/setup/lazy";
import type { AuthStorage, Model } from "@oh-my-pi/pi-ai";
import type { SetupHost, SetupProviderAuthPort, SetupScene } from "@oh-my-pi/pi-tui/setup/scenes/types";
import {
	ALL_SCENES,
	CURRENT_SETUP_VERSION,
	runSetupWizard as runWizard,
	type RunSetupWizardOptions as TuiRunSetupWizardOptions,
	selectSetupScenes as selectScenes,
	type SetupSceneSelectionOptions,
} from "@oh-my-pi/pi-tui/setup/wizard";
import { authenticateProvider } from "../breadboard/provider-auth-login";
import type { ProviderAuthPort } from "../breadboard/provider-auth-port";
import { formatModelString, resolveModelRoleValue, rolePriorityDefaults } from "../config/model-resolver";
import { getRoleInfo } from "../config/model-roles";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { captureBrowserSession } from "../utils/browser-session";
import { copyToClipboard } from "../utils/clipboard";
import { getGroundedSearchProvider, getSearchProvider } from "../web/search/provider";
import { SEARCH_PROVIDER_OPTIONS, type SearchProviderId } from "../web/search/types";
import { createModelBrowserSource } from "./model-browser-source";
import { ACTIVE_PRODUCT_IDENTITY, OMP_PRODUCT_IDENTITY } from "../product-identity";
import type { InteractiveModeContext } from "./types";
export { ALL_SCENES, CURRENT_SETUP_VERSION };
export type { SetupScene, SetupSceneHost } from "@oh-my-pi/pi-tui/setup/scenes/types";
export { runStartupSplash } from "@oh-my-pi/pi-tui/setup/startup-splash";

const WEB_SEARCH_GROUNDINGS: Readonly<Record<WebSearchGrounding, true>> = {
	gemini: true,
	anthropic: true,
	codex: true,
	xai: true,
	openrouter: true,
};

function isWebSearchGrounding(id: SearchProviderId): id is WebSearchGrounding {
	return id in WEB_SEARCH_GROUNDINGS;
}

/**
 * Setup-only dependency surface. Setup scenes never need the rest of InteractiveMode,
 * and standalone product setup runs without a session at all.
 */
export interface SetupWizardContext {
	readonly ui: SetupHost["ui"];
	readonly settings: Settings;
	readonly modelRegistry: ModelRegistry;
	readonly modelSelection: SetupModelSelectionSource;
	readonly statusLine?: SetupHost["statusLine"];
	openInBrowser(url: string): void;
	playWelcomeIntro?(): void;
	showError?(message: string): void;
}

/** Where setup reads and writes the default model: native role storage or the engine-owned session. */
export interface SetupModelSelectionSource {
	readonly mode: "default" | "session";
	readonly currentModel: Model | undefined;
	availableModels(): readonly Model[];
	refresh(): Promise<void>;
	select(model: Model, selector: string): Promise<void>;
}

/**
 * Adapt the live interactive session to the setup-only dependency surface.
 * Engine-owned sessions pick from the session's scoped catalog and switch models
 * for the session only; native sessions keep role-storage persistence.
 */
export function createInteractiveSetupContext(ctx: InteractiveModeContext): SetupWizardContext {
	// Read the session on use: setup hosts are built before scenes decide what they need.
	const engineOwned = () => ctx.session.mainStreamOwnsTurnLifecycle;
	return {
		ui: ctx.ui,
		settings: ctx.settings,
		get modelRegistry() {
			return ctx.session.modelRegistry;
		},
		modelSelection: {
			get mode() {
				return engineOwned() ? "session" : "default";
			},
			get currentModel() {
				return ctx.session.model;
			},
			availableModels: () =>
				engineOwned() ? ctx.session.scopedModels.map(entry => entry.model) : ctx.session.modelRegistry.getAvailable(),
			refresh: async () => {
				if (!engineOwned()) await ctx.session.modelRegistry.refresh("online-if-uncached");
			},
			select: async (model, selector) => {
				if (engineOwned()) {
					await ctx.session.setModelTemporary(model);
					return;
				}
				const projectScope = ctx.settings.get("modelRoleStorage") === "project";
				await ctx.session.setModel(model, "default", { selector, persist: !projectScope });
				if (projectScope) ctx.settings.setProjectModelRole("default", selector);
				await ctx.settings.flush();
			},
		},
		get statusLine() {
			return ctx.statusLine;
		},
		openInBrowser: url => ctx.openInBrowser(url),
		playWelcomeIntro: () => ctx.playWelcomeIntro(),
		showError: message => ctx.showError(message),
	};
}

/** Setup entry points accept a live session context or a session-free setup context. */
export type SetupContextSource = InteractiveModeContext | SetupWizardContext;

function toSetupContext(source: SetupContextSource): SetupWizardContext {
	return "modelSelection" in source ? source : createInteractiveSetupContext(source);
}

function webRoleModels(ctx: SetupWizardContext) {
	return ctx.modelRegistry.getAll("all").filter(getRoleInfo("web", ctx.settings).accepts);
}

function resolveWebSearchSelection(ctx: SetupWizardContext, id: SearchProviderId) {
	const models = webRoleModels(ctx);
	if (!isWebSearchGrounding(id)) {
		const selector = `web/${id}`;
		const model = resolveModelRoleValue(selector, models, { settings: ctx.settings }).model;
		return model ? { selector, model } : undefined;
	}

	for (const selector of rolePriorityDefaults("web")) {
		const model = resolveModelRoleValue(selector, models, { settings: ctx.settings }).model;
		if (model?.webSearch === id) return { selector, model };
	}
	const model = models.find(candidate => candidate.webSearch === id);
	return model ? { selector: formatModelString(model), model } : undefined;
}

function createProviderAuthAdapter(port: ProviderAuthPort): SetupProviderAuthPort {
	return {
		listProviders: () => port.listProviders(),
		listCredentials: providerId => port.listCredentials(providerId),
		listProvidersSync: port.listProvidersSync?.bind(port),
		listCredentialsSync: port.listCredentialsSync?.bind(port),
		authenticate: async (providerId, options) => {
			const credential = await authenticateProvider(port, providerId, {
				signal: options.signal,
				selectAuthScheme: async (provider, schemes) =>
					(await options.selectAuthScheme?.(provider, schemes)) ?? schemes[0] ?? "",
				selectOAuthFlow: options.selectOAuthFlow
					? provider => options.selectOAuthFlow?.(provider) ?? Promise.resolve(undefined)
					: undefined,
				showAuthorization: options.showAuthorization,
				prompt: options.prompt,
				showProgress: options.showProgress,
			});
			return { accountLabel: credential.accountLabel };
		},
	};
}

export interface SetupHostOptions {
	/** Product credential broker; sign-in goes through it instead of native storage. */
	readonly providerAuthPort?: ProviderAuthPort;
	/** Native credential store consulted for provider availability when it differs from the registry's. */
	readonly nativeAuthStorage?: AuthStorage;
}

/** Bind application preferences and runtime effects to the setup presentation. */
export function createSetupHost(source: SetupContextSource, options: SetupHostOptions = {}): SetupHost {
	const ctx = toSetupContext(source);
	const modelSource = createModelBrowserSource(ctx.settings);
	// Product builds sign in through the broker or an explicitly shared native store,
	// never silently into the registry's private store.
	const signInStorage = () =>
		options.nativeAuthStorage ??
		(ACTIVE_PRODUCT_IDENTITY.id === OMP_PRODUCT_IDENTITY.id ? ctx.modelRegistry.authStorage : undefined);
	return {
		ui: ctx.ui,
		identity: ACTIVE_PRODUCT_IDENTITY,
		settings: {
			get: <T>(key: string) => ctx.settings.get(key as never) as T,
			set: (key, value) => ctx.settings.set(key as never, value as never),
			getGroup: group => ctx.settings.getGroup(group as never) as Record<string, unknown>,
			flush: () => ctx.settings.flush(),
		},
		modelSelection: ctx.modelSelection,
		get statusLine() {
			return ctx.statusLine;
		},
		get composerShape() {
			return ctx.settings.get("composer.shape") ?? "band";
		},
		get symbolPreset() {
			return ctx.settings.get("symbolPreset");
		},
		get colorBlindMode() {
			return ctx.settings.get("colorBlindMode");
		},
		get webSearchOrder() {
			const configured = ctx.settings.getModelRole("web")?.trim();
			if (!configured) return [];
			const model = resolveModelRoleValue(configured, webRoleModels(ctx), { settings: ctx.settings }).model;
			if (model?.provider === "web") {
				const option = SEARCH_PROVIDER_OPTIONS.find(candidate => candidate.value === model.id);
				if (option && option.value !== "auto" && option.value !== "none") return [option.value];
			}
			return model?.webSearch ? [model.webSearch] : [];
		},
		get disabledProviders() {
			return ctx.settings.get("disabledProviders");
		},
		get authStorage() {
			return signInStorage();
		},
		providerAuth: options.providerAuthPort ? createProviderAuthAdapter(options.providerAuthPort) : undefined,
		modelSource,
		getModels: () => ({
			available: [...ctx.modelSelection.availableModels()],
			all: ctx.modelRegistry.getAll(),
			current: ctx.modelSelection.currentModel,
		}),
		refreshModels: () => ctx.modelSelection.refresh(),
		selectModel: (model, selector) => ctx.modelSelection.select(model, selector),
		refreshProvider: provider => ctx.modelRegistry.refreshProvider(provider, "online"),
		saveComposerShape: async shape => {
			ctx.settings.set("composer.shape", shape);
			await ctx.settings.flush();
		},
		saveSymbolPreset: preset => {
			ctx.settings.set("symbolPreset", preset);
		},
		saveColorBlindMode: enabled => {
			ctx.settings.set("colorBlindMode", enabled);
		},
		saveTheme: (mode, name) => {
			ctx.settings.set(`theme.${mode}`, name);
		},
		isSearchProviderAvailable: async id => {
			const selection = resolveWebSearchSelection(ctx, id);
			if (!selection) return false;
			const provider = selection.model.webSearch
				? await getGroundedSearchProvider(selection.model.webSearch)
				: await getSearchProvider(selection.model.id);
			return provider.isExplicitlyAvailable(signInStorage() ?? ctx.modelRegistry.authStorage, selection.model);
		},
		saveSearchProvider: id => {
			if (id === "auto") {
				ctx.settings.setModelRole("web", undefined);
				return;
			}
			const selection = resolveWebSearchSelection(ctx, id);
			if (selection) ctx.settings.setModelRole("web", selection.selector);
		},
		captureBrowserSession,
		copyToClipboard,
		openInBrowser: url => ctx.openInBrowser(url),
		markComplete: version => markSetupWizardComplete(ctx.settings, version),
		playWelcomeIntro: () => ctx.playWelcomeIntro?.(),
		showError: message => ctx.showError?.(message),
	};
}

/** Persist completion only after the setup overlay finishes. */
export async function markSetupWizardComplete(settings: Settings, version = CURRENT_SETUP_VERSION): Promise<void> {
	settings.set("setupVersion", version);
	await settings.flush();
}

/** Select eligible setup scenes using the application's live capabilities. */
export function selectSetupScenes(
	storedVersion: number,
	scenes: readonly SetupScene[],
	ctx?: SetupContextSource,
	options: SetupSceneSelectionOptions = {},
): Promise<SetupScene[]> {
	return selectScenes(storedVersion, scenes, ctx ? createSetupHost(ctx) : undefined, options);
}

export type RunSetupWizardOptions = TuiRunSetupWizardOptions & SetupHostOptions;

/** Run setup with application-owned persistence and provider effects. */
export function runSetupWizard(
	ctx: SetupContextSource,
	scenes: readonly SetupScene[] = ALL_SCENES,
	options: RunSetupWizardOptions = {},
): Promise<void> {
	return runWizard(createSetupHost(ctx, options), scenes, options);
}

/** Open provider setup without advancing onboarding or replaying the welcome intro. */
export function runProviderSetupWizard(ctx: InteractiveModeContext, options: SetupHostOptions = {}): Promise<void> {
	return runProviderWizard(createSetupHost(ctx, options));
}
