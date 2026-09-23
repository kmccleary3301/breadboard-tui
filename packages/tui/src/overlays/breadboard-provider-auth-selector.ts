import {
	Container,
	extractPrintableText,
	matchesKey,
	ScrollView,
	type SgrMouseEvent,
	Spacer,
	TruncatedText,
} from "../index";
import { theme } from "../theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { OverlayPanel } from "../chrome/overlay-box";
import { MenuSelection } from "../components/menu-selection";
import { centeredViewportRange } from "../components/scroll-viewport";

export type AuthSchemeId = "api_key" | "oauth2";
export type AuthCredentialStatus = "active" | "disabled" | "revoked" | "reauthorization_required" | "quarantined";
export interface AuthProviderView {
	readonly providerId: string;
	readonly displayName: string;
	readonly supportTier: "core" | "unsupported";
	readonly authOwner: "broker" | "provider";
	readonly available: boolean;
	readonly availabilityReason?: "provider_managed" | "missing_auth" | "unsupported" | null;
	readonly authSchemes: readonly AuthSchemeId[];
	readonly loginAvailable: boolean;
	readonly storeCredentialsAs?: string;
}
export interface AuthCredentialView {
	readonly providerId: string;
	readonly status: AuthCredentialStatus;
	readonly source?: string;
}
export interface ProviderAuthReadPort {
	listProviders(): Promise<ReadonlyArray<AuthProviderView>>;
	listCredentials(providerId?: string): Promise<ReadonlyArray<AuthCredentialView>>;
	listProvidersSync?(): ReadonlyArray<AuthProviderView>;
	listCredentialsSync?(providerId?: string): ReadonlyArray<AuthCredentialView>;
}

type SelectorProvider = AuthProviderView & {
	readonly id: string;
	readonly name: string;
	readonly storeCredentialsAs?: string;
};
const OAUTH_SELECTOR_MAX_VISIBLE = 10;

/**
 * Rendered lines before the provider rows: top border
 * (must mirror the constructor's addChild order).
 */
const LIST_ROW_OFFSET = 1;

/** Compact, human-readable tag for each credential-origin leg. */
const ORIGIN_LABELS = {
	runtime: "--api-key",
	config: "config",
	oauth: "login",
	api_key: "api key",
	env: "env",
	fallback: "custom provider",
};
/**
 * BreadBoard provider-auth selector. This data-source-backed variant is kept
 * separate from the native OAuth selector so native callers retain the stock
 * synchronous auth-storage contract.
 */
export class BreadboardProviderAuthSelectorComponent extends OverlayPanel {
	#listContainer: Container;
	#menu: MenuSelection<SelectorProvider>;
	#allProviders: SelectorProvider[] = [];
	#filteredProviders: SelectorProvider[] = [];
	#hoveredIndex: number | null = null;
	/** First provider index of the visible ScrollView window (last #updateList). */
	#scrollStart = 0;
	#visibleCount = 0;
	/** Visible list window, shrunk by {@link setMaxHeight} on short screens. */
	#maxVisible = OAUTH_SELECTOR_MAX_VISIBLE;
	#mode: "login" | "logout" | "revoke";
	#dataSource: ProviderAuthReadPort;
	#credentials: AuthCredentialView[] = [];
	#onSelectCallback: (providerId: string) => void;
	#onCancelCallback: () => void;
	#statusMessage: string | undefined;
	#loading = true;
	#closed = false;
	#validateAuthCallback?: (providerId: string) => Promise<boolean>;
	#requestRenderCallback?: () => void;
	#authState: Map<string, "checking" | "valid" | "invalid"> = new Map();
	#spinnerFrame = 0;
	#spinnerInterval?: NodeJS.Timeout;
	#validationGeneration = 0;
	readonly ready: Promise<void>;
	constructor(
		mode: "login" | "logout" | "revoke",
		dataSource: ProviderAuthReadPort,
		onSelect: (providerId: string) => void,
		onCancel: () => void,
		options?: {
			disabledProviders?: readonly string[];
			validateAuth?: (providerId: string) => Promise<boolean>;
			requestRender?: () => void;
		},
	) {
		super(
			mode === "login"
				? "Select provider to login"
				: mode === "logout"
					? "Select provider to logout"
					: "Select provider credential to revoke",
		);
		this.#mode = mode;
		this.#dataSource = dataSource;
		this.#onSelectCallback = onSelect;
		this.#onCancelCallback = onCancel;
		this.#validateAuthCallback = options?.validateAuth;
		this.#requestRenderCallback = options?.requestRender;
		this.#disabledProviders = options?.disabledProviders ?? [];
		this.#menu = new MenuSelection<SelectorProvider>([], {
			getKey: provider => provider.id,
			getSearchText: provider => this.#getProviderSearchText(provider),
		});
		this.#listContainer = new Container();
		this.addChild(this.#listContainer);
		const syncProviders = dataSource.listProvidersSync?.();
		const syncCredentials = dataSource.listCredentialsSync?.();
		if (syncProviders !== undefined && syncCredentials !== undefined) {
			this.#applyProviders(syncProviders, syncCredentials);
			this.ready = Promise.resolve();
		} else {
			this.ready = this.#loadProviders().catch(error => {
				if (this.#closed) return;
				this.#loading = false;
				this.#statusMessage = error instanceof Error ? error.message : "Unable to load provider status.";
				this.#updateList();
				this.#requestRenderCallback?.();
			});
		}
		this.#updateList();
	}

	stopValidation(): void {
		this.#closed = true;
		this.#validationGeneration += 1;
		this.#stopSpinner();
	}

	/**
	 * Fit the selector into `lines` rendered rows by shrinking the visible list
	 * window (the window is centered on the selection, so the selected row is
	 * always visible at any height). Prefers keeping the full chrome — borders,
	 * spacers, title, search status — but sacrifices the trailing spacer/border
	 * (clipped by the host) before dropping below three visible rows.
	 */
	setMaxHeight(lines: number): void {
		// Above the rows: LIST_ROW_OFFSET; below: search status + border.
		const strict = lines - LIST_ROW_OFFSET - 2;
		// Keeps only the rows + search status inside `lines`.
		const relaxed = lines - LIST_ROW_OFFSET - 1;
		const rows = Math.min(OAUTH_SELECTOR_MAX_VISIBLE, Math.max(1, strict, Math.min(relaxed, 3)));
		if (rows === this.#maxVisible) return;
		this.#maxVisible = rows;
		this.#updateList();
	}
	#hasSelectableAuth(providerId: string): boolean {
		return this.#credentials.some(credential => {
			if (credential.providerId !== providerId) return false;
			return this.#mode === "revoke" ? credential.status !== "revoked" : credential.status === "active";
		});
	}

	#canLogin(provider: AuthProviderView): boolean {
		if (
			provider.supportTier !== "core" ||
			provider.availabilityReason === "provider_managed" ||
			(!provider.available && provider.availabilityReason !== "missing_auth")
		) {
			return false;
		}
		return (
			provider.authSchemes.includes("api_key") ||
			(provider.authSchemes.includes("oauth2") && provider.loginAvailable)
		);
	}

	#availabilityLabel(provider: AuthProviderView): string {
		if (this.#mode !== "login") return "";
		if (provider.availabilityReason === "missing_auth") return theme.fg("muted", " (credentials required)");
		if (this.#canLogin(provider)) return "";
		const reason = provider.availabilityReason === "provider_managed" ? "provider managed" : "unavailable";
		return theme.fg("muted", ` (${reason})`);
	}

	#applyProviders(providers: ReadonlyArray<AuthProviderView>, credentials: ReadonlyArray<AuthCredentialView>): void {
		this.#loading = false;
		this.#credentials = credentials.map(credential => ({ ...credential }));
		const rows = providers.map(provider => ({ ...provider, id: provider.providerId, name: provider.displayName }));
		if (this.#mode !== "login") {
			this.#allProviders = rows.filter(provider => this.#hasSelectableAuth(provider.id));
		} else {
			const disabled = new Set(this.#disabledProviders);
			this.#allProviders = rows.filter(
				provider =>
					!disabled.has(provider.id) &&
					!(provider.storeCredentialsAs && disabled.has(provider.storeCredentialsAs)),
			);
		}
		this.#menu.setItems(this.#allProviders);
		this.#filteredProviders = this.#allProviders;
		this.#updateList();
		this.#startValidation();
		this.#requestRenderCallback?.();
	}

	#disabledProviders: readonly string[] = [];

	async #loadProviders(): Promise<void> {
		const [providers, credentials] = await Promise.all([
			this.#dataSource.listProviders(),
			this.#dataSource.listCredentials(),
		]);
		if (this.#closed) return;
		this.#applyProviders(providers, credentials);
	}

	#startValidation(): void {
		if (!this.#validateAuthCallback) return;
		const generation = this.#validationGeneration + 1;
		this.#validationGeneration = generation;

		let pending = 0;
		for (const provider of this.#menu.items) {
			if (!this.#hasSelectableAuth(provider.id)) {
				this.#authState.delete(provider.id);
				continue;
			}
			this.#authState.set(provider.id, "checking");
			pending += 1;
			void this.#validateProvider(provider.id, generation);
		}

		if (pending > 0) {
			this.#startSpinner();
			this.#updateList();
			this.#requestRenderCallback?.();
		}
	}

	async #validateProvider(providerId: string, generation: number): Promise<void> {
		if (!this.#validateAuthCallback) return;
		let isValid = false;
		try {
			isValid = await this.#validateAuthCallback(providerId);
		} catch {
			isValid = false;
		}

		if (generation !== this.#validationGeneration) return;
		this.#authState.set(providerId, isValid ? "valid" : "invalid");
		if (![...this.#authState.values()].includes("checking")) {
			this.#stopSpinner();
		}
		this.#updateList();
		this.#requestRenderCallback?.();
	}

	#startSpinner(): void {
		if (this.#spinnerInterval) return;
		this.#spinnerInterval = setInterval(() => {
			const frameCount = theme.spinnerFrames.length;
			if (frameCount > 0) {
				this.#spinnerFrame = (this.#spinnerFrame + 1) % frameCount;
			}
			this.#updateList();
			this.#requestRenderCallback?.();
		}, 80);
	}

	#stopSpinner(): void {
		if (this.#spinnerInterval) {
			clearInterval(this.#spinnerInterval);
			this.#spinnerInterval = undefined;
		}
	}

	/**
	 * Muted provenance suffix (" (env: COPILOT_GITHUB_TOKEN)", " (login)", …) so
	 * the list distinguishes a real login from an env var aliasing the provider.
	 */
	#getSourceLabel(providerId: string): string {
		const credential = this.#credentials.find(
			item =>
				item.providerId === providerId &&
				(this.#mode === "revoke" ? item.status !== "revoked" : item.status === "active"),
		);
		if (!credential?.source) return "";
		const detail = ORIGIN_LABELS[credential.source as keyof typeof ORIGIN_LABELS] ?? credential.source;
		return theme.fg("muted", ` (${detail})`);
	}

	#getStatusIndicator(providerId: string): string {
		const state = this.#authState.get(providerId);
		const source = this.#getSourceLabel(providerId);
		if (state === "checking") {
			const frameCount = theme.spinnerFrames.length;
			const spinner = frameCount > 0 ? theme.spinnerFrames[this.#spinnerFrame % frameCount] : theme.status.pending;
			return theme.fg("warning", ` ${spinner} checking`) + source;
		}
		if (state === "invalid") {
			return theme.fg("error", ` ${theme.status.error} invalid`) + source;
		}
		if (state === "valid") {
			return theme.fg("success", ` ${theme.status.enabled} logged in`) + source;
		}
		return this.#hasSelectableAuth(providerId)
			? theme.fg("success", ` ${theme.status.enabled} logged in`) + source
			: "";
	}

	#isSearchEnabled(): boolean {
		return this.#menu.items.length > this.#maxVisible;
	}

	#shouldRenderSearchStatus(): boolean {
		return this.#isSearchEnabled() || this.#menu.query.length > 0;
	}

	#renderStatusLine(_total: number): string {
		const query = this.#menu.query.trim();
		const suffix = query ? `Search: ${this.#menu.query}` : "Type to search";
		return theme.fg("muted", suffix);
	}

	#getProviderSearchText(provider: SelectorProvider): string {
		let text = `${provider.name} ${provider.id}`;
		const credential = this.#credentials.find(item => item.providerId === provider.id && item.status === "active");
		if (credential?.source)
			text += ` logged in authenticated ${ORIGIN_LABELS[credential.source as keyof typeof ORIGIN_LABELS] ?? credential.source}`;
		if (!this.#canLogin(provider)) text += ` ${provider.availabilityReason ?? "unavailable"}`;
		return text;
	}

	#setSearchQuery(query: string): void {
		this.#menu.setQuery(query, false);
		this.#statusMessage = undefined;
		this.#updateList();
	}

	#handleSearchInput(keyData: string): boolean {
		if (!this.#isSearchEnabled()) return false;

		if (matchesKey(keyData, "backspace")) {
			if (this.#menu.query.length === 0) return false;
			const chars = [...this.#menu.query];
			chars.pop();
			this.#setSearchQuery(chars.join(""));
			return true;
		}

		const printableText = extractPrintableText(keyData);
		if (printableText === undefined) return false;
		if (this.#menu.query.length === 0 && printableText.trim().length === 0) return false;

		this.#setSearchQuery(this.#menu.query + printableText);
		return true;
	}

	#updateList(): void {
		this.#listContainer.clear();

		const items = this.#menu.visibleItems;
		const total = items.length;
		const maxVisible = this.#maxVisible;
		const { start: startIndex, end: endIndex } = centeredViewportRange(this.#menu.selectedIndex, total, maxVisible);
		this.#scrollStart = startIndex;
		this.#visibleCount = endIndex - startIndex;

		const rows: string[] = [];
		for (let i = startIndex; i < endIndex; i++) {
			const provider = items[i];
			if (!provider) continue;
			const isSelected = i === this.#menu.selectedIndex;
			const isAvailable = this.#mode !== "login" || this.#canLogin(provider);
			const statusIndicator = this.#getStatusIndicator(provider.id);
			const availabilityLabel = this.#availabilityLabel(provider);

			let line = "";
			if (isSelected) {
				const prefix = theme.fg("accent", `${theme.nav.cursor} `);
				const text = isAvailable ? theme.fg("accent", provider.name) : theme.fg("dim", provider.name);
				line = prefix + text + statusIndicator + availabilityLabel;
			} else {
				const text = isAvailable ? `  ${provider.name}` : theme.fg("dim", `  ${provider.name}`);
				line = text + statusIndicator + availabilityLabel;
			}
			if (!isSelected && i === this.#hoveredIndex) {
				line = theme.bg("selectedBg", line);
			}
			rows.push(line);
		}

		if (rows.length > 0) {
			const sv = new ScrollView(rows, {
				height: rows.length,
				scrollbar: "auto",
				totalRows: total,
				theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
			});
			sv.setScrollOffset(startIndex);
			this.#listContainer.addChild(sv);
		}

		// Search status line (scrollbar covers overflow indication)
		if (this.#shouldRenderSearchStatus()) {
			this.#listContainer.addChild(new TruncatedText(this.#renderStatusLine(total), 0, 0));
		}
		if (total === 0 && !this.#statusMessage) {
			const message = this.#loading
				? "Loading providers…"
				: this.#allProviders.length > 0
					? "No matching providers"
					: this.#mode === "login"
						? "No providers available"
						: this.#mode === "revoke"
							? "No stored provider credentials to revoke"
							: "No stored provider credentials to log out";
			this.#listContainer.addChild(new TruncatedText(theme.fg("muted", message), 0, 0));
		}
		if (this.#statusMessage) {
			this.#listContainer.addChild(new Spacer(1));
			this.#listContainer.addChild(new TruncatedText(theme.fg("warning", this.#statusMessage), 0, 0));
		}
	}
	handleInput(keyData: string): void {
		// Escape or Ctrl+C
		if (matchesSelectCancel(keyData)) {
			this.stopValidation();
			this.#onCancelCallback();
			return;
		}

		if (this.#handleSearchInput(keyData)) {
			return;
		}

		// Up arrow
		if (matchesSelectUp(keyData)) {
			this.#menu.move(-1, true);
			this.#statusMessage = undefined;
			this.#updateList();
		}
		// Down arrow
		else if (matchesSelectDown(keyData)) {
			this.#menu.move(1, true);
			this.#statusMessage = undefined;
			this.#updateList();
		}
		// Page up - jump up by one visible page
		else if (matchesKey(keyData, "pageUp")) {
			this.#menu.move(-this.#maxVisible, false);
			this.#statusMessage = undefined;
			this.#updateList();
		}
		// Page down - jump down by one visible page
		else if (matchesKey(keyData, "pageDown")) {
			this.#menu.move(this.#maxVisible, false);
			this.#statusMessage = undefined;
			this.#updateList();
		}
		// Enter
		else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			this.#confirmSelection();
		}
	}

	/** Confirm the selected provider (Enter or mouse click). */
	#confirmSelection(): void {
		const selectedProvider = this.#menu.selectedItem;
		if (selectedProvider && (this.#mode !== "login" || this.#canLogin(selectedProvider))) {
			this.#statusMessage = undefined;
			this.stopValidation();
			this.#onSelectCallback(selectedProvider.id);
		} else if (selectedProvider) {
			this.#statusMessage =
				selectedProvider.availabilityReason === "provider_managed"
					? "This provider manages login outside BreadBoard."
					: "Provider unavailable in this environment.";
			this.#updateList();
		}
	}

	/** Move the selection one step for a wheel notch (clamped, no wrap). */
	handleWheel(delta: -1 | 1): void {
		if (this.#menu.visibleItems.length === 0) return;
		if (!this.#menu.move(delta, false)) return;
		this.#statusMessage = undefined;
		this.#updateList();
	}

	/**
	 * Route an SGR mouse report at component-local coordinates. Provider rows
	 * start LIST_ROW_OFFSET lines into the render; the ScrollView window shows
	 * #visibleCount rows from #scrollStart. Wheel moves the selection, motion
	 * drives the hover band, and a left click selects and confirms like Enter.
	 */
	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		if (event.wheel !== null) {
			this.handleWheel(event.wheel);
			return;
		}
		const localRow = line - LIST_ROW_OFFSET;
		const index = localRow >= 0 && localRow < this.#visibleCount ? this.#scrollStart + localRow : undefined;
		const target = index !== undefined && index < this.#menu.visibleItems.length ? index : null;
		if (event.motion) {
			if (target !== this.#hoveredIndex) {
				this.#hoveredIndex = target;
				this.#updateList();
			}
			return;
		}
		if (!event.leftClick || target === null) return;
		if (target !== this.#menu.selectedIndex) {
			this.#menu.setSelectedIndex(target);
			this.#statusMessage = undefined;
		}
		this.#confirmSelection();
	}
}
