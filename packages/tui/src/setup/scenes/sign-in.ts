import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { PASTE_CODE_LOGIN_PROVIDERS } from "@oh-my-pi/pi-ai";
import type { OAuthPrompt, OAuthProvider } from "@oh-my-pi/pi-ai/oauth/types";
import { type Component, type Focusable, Container } from "../../tui";
import { Spacer } from "../../components/spacer";
import { Text } from "../../components/text";
import { WizardStep } from "../../components/wizard-step";
import { Input } from "../../components/input";
import { matchesKey } from "../../keys";
import { type SgrMouseEvent } from "../../mouse";
import { wrapTextWithAnsi } from "../../utils";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import { captureBrowserSession } from "../../../utils/browser-session";
import { authenticateProvider } from "../../../breadboard/provider-auth-login";
import {
	ProviderAuthError,
	type ProviderAuthPort,
	type ProviderAuthReadPort,
} from "../../../breadboard/provider-auth-port";
import { BREADBOARD_PRODUCT_IDENTITY, OMP_PRODUCT_IDENTITY } from "../../../product-identity";
import { copyToClipboard } from "../../../utils/clipboard";
import { createNativeProviderAuthDataSource } from "../../components/oauth-provider-data-source";
import { OAuthSelectorComponent } from "../../components/oauth-selector";
import { theme } from "../../theme/theme";
import type { SetupSceneHost, SetupTab } from "./types";

const UNAVAILABLE_PRODUCT_PROVIDER_SOURCE: ProviderAuthReadPort = Object.freeze({
	listProvidersSync: () => [],
	listCredentialsSync: () => [],
	async listProviders() {
		return [];
	},
	async listCredentials() {
		return [];
	},
});

function loginUrlLink(url: string): string {
	return `\x1b]8;;${url}\x07Open login URL\x1b]8;;\x07`;
}

function loginCopyHint(): string {
	return theme.fg("dim", "(clipboard copy attempted; Alt+C retries)");
}

class CopyablePromptInput implements Component, Focusable {
	#input: Input;
	#onCopy: () => void;

	constructor(input: Input, onCopy: () => void) {
		this.#input = input;
		this.#onCopy = onCopy;
	}

	get focused(): boolean {
		return this.#input.focused;
	}

	set focused(value: boolean) {
		this.#input.focused = value;
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#input.setUseTerminalCursor(useTerminalCursor);
	}

	render(width: number): readonly string[] {
		return this.#input.render(width);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "alt+c")) {
			this.#onCopy();
			return;
		}
		this.#input.handleInput(data);
	}
	clear(): void {
		this.#input.setValue("");
		this.#input.mask = false;
	}

	invalidate(): void {
		this.#input.invalidate();
	}
}

interface PromptState {
	message: string;
	placeholder?: string;
	input: CopyablePromptInput;
}

/**
 * "Sign in" panel: lets the user authenticate one or more model providers via
 * OAuth. Unlike a standalone scene it never auto-advances the wizard — the user
 * may sign in to several providers and then continue with Esc.
 */
export class SignInTab implements SetupTab {
	readonly id = "sign-in";
	readonly label = "Sign in";

	#authStorage: AuthStorage | undefined;
	#providerAuthPort: ProviderAuthPort | undefined;
	#productAuthUnavailable = false;
	#selector: OAuthSelectorComponent;
	#statusLines: string[] = [];
	#authUrl: string | undefined;
	#authLaunchUrl: string | undefined;
	#prompt: PromptState | undefined;
	#promptResolve: ((value: string) => void) | undefined;
	#promptReject: ((error: Error) => void) | undefined;
	#promptAbortCleanup: (() => void) | undefined;
	#loginAbort: AbortController | undefined;
	#loggingInProvider: string | undefined;
	#disposed = false;
	#step: WizardStep | undefined;

	constructor(private readonly host: SetupSceneHost) {
		this.#providerAuthPort = host.providerAuthPort;
		if (!this.#providerAuthPort) {
			if (host.nativeAuthStorage) {
				this.#authStorage = host.nativeAuthStorage;
			} else if (host.identity.id === OMP_PRODUCT_IDENTITY.id) {
				this.#authStorage = host.ctx.modelRegistry.authStorage;
			} else {
				this.#productAuthUnavailable = true;
			}
		}
		this.#selector = this.#createSelector();
	}

	/** Modal while an OAuth flow is running so the scene won't switch tabs or finish. */
	get modal(): boolean {
		return this.#loggingInProvider !== undefined;
	}

	dispose(): void {
		this.#disposed = true;
		this.#selector.stopValidation();
		this.#loginAbort?.abort();
		this.#resolvePrompt("");
	}

	invalidate(): void {
		this.#step?.invalidate();
		this.#selector.invalidate();
		this.#prompt?.input.invalidate();
	}

	handleInput(data: string): void {
		if (this.#loggingInProvider) {
			if (this.#prompt) {
				this.#prompt.input.handleInput(data);
				return;
			}
			if (this.#authUrl && (matchesKey(data, "alt+c") || (data === "c" && !this.#prompt))) {
				void this.#copyAuthUrl();
				return;
			}
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				this.#loginAbort?.abort();
			}
			return;
		}
		this.#selector.handleInput(data);
	}

	/** Forward mouse to the provider selector; pointer is inert during an active login or code prompt. */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (this.#loggingInProvider || this.#prompt) return;
		this.#step?.routeMouse(event, line, col);
	}

	render(width: number, maxLines?: number): readonly string[] {
		const lines: string[] = [];
		if (this.#loggingInProvider) {
			lines.push(theme.bold(`Signing in to ${this.#loggingInProvider}`));
		} else {
			if (this.#productAuthUnavailable) {
				lines.push(
					theme.fg("error", `${this.host.identity.displayName} provider setup is unavailable.`),
					theme.fg(
						"dim",
						`Press Esc to continue; retry with \`${this.host.identity.cliName} setup\` when the auth broker is ready.`,
					),
					"",
				);
			} else if (maxLines === undefined || maxLines >= 17 + 2) {
				// Hint + blank cost two rows; on short screens the rows go to the provider list.
				lines.push(theme.fg("muted", "Pick a provider to sign in — you can connect more than one."), "");
			}
			this.#selectorRowStart = lines.length;
			if (maxLines !== undefined) this.#selector.setMaxHeight(maxLines - lines.length);
			lines.push(...this.#selector.render(width));
		}
		const tail = new Container();
		const urlLines = this.#authUrl ? wrapTextWithAnsi(theme.fg("dim", this.#authUrl), width) : [];
		if (this.#authUrl) {
			tail.addChild(
				new Text(theme.fg("accent", `Browser login: ${loginUrlLink(this.#authUrl)} ${loginCopyHint()}`), 0, 0),
			);
			// Keep one URL row above the prompt; repeat the complete wrapped URL
			// below so the input remains visible in the wizard's short viewport.
			if (urlLines[0]) tail.addChild(new Text(urlLines[0], 0, 0));
			if (this.#authLaunchUrl) {
				tail.addChild(
					new Text(theme.fg("dim", `Local shortcut (this machine only): ${this.#authLaunchUrl}`), 0, 0),
				);
			}
		}
		if (this.#prompt) {
			tail.addChild(new Text(theme.fg("warning", this.#prompt.message), 0, 0));
			if (this.#prompt.placeholder) {
				tail.addChild(new Text(theme.fg("dim", this.#prompt.placeholder), 0, 0));
			}
			tail.addChild(this.#prompt.input);
		}
		if (urlLines.length > 1) {
			for (const line of urlLines) {
				tail.addChild(new Text(line, 0, 0));
			}
		}
		for (const line of this.#statusLines) {
			for (const wrapped of wrapTextWithAnsi(line, width)) {
				tail.addChild(new Text(wrapped, 0, 0));
			}
		}
		if (!this.#step) {
			this.#step = new WizardStep({
				kind: "choice",
				content: this.#selector,
				gap: 0,
				fitContent: budget => {
					if (budget !== undefined) this.#selector.setMaxHeight(budget);
				},
			});
		}
		if (this.#loggingInProvider) {
			this.#step.setKind("async");
			this.#step.setHeading(new Text(theme.bold(`Signing in to ${this.#loggingInProvider}`), 0, 0));
			this.#step.setIntro(undefined);
			this.#step.setContent(tail);
			this.#step.setStatus(undefined);
		} else {
			this.#step.setKind("choice");
			this.#step.setHeading(undefined);
			this.#step.setIntro(intro);
			this.#step.setContent(this.#selector);
			this.#step.setStatus(tail);
		}
		this.#step.setMaxHeight(maxLines);
		return this.#step.render(width);
	}

	#createSelector(): OAuthSelectorComponent {
		const dataSource =
			this.#providerAuthPort ??
			(this.#authStorage
				? createNativeProviderAuthDataSource(this.#authStorage)
				: UNAVAILABLE_PRODUCT_PROVIDER_SOURCE);
		return new OAuthSelectorComponent(
			"login",
			dataSource,
			providerId => {
				void this.#login(providerId);
			},
			() => this.host.finish("skipped"),
			{
				validateAuth: this.#providerAuthPort
					? async providerId =>
							(await this.#providerAuthPort?.listCredentials(providerId))?.some(
								credential => credential.status === "active",
							) === true
					: undefined,
				requestRender: () => this.host.requestRender(),
			},
		);
	}

	async #login(providerId: string): Promise<void> {
		if (this.#loggingInProvider || this.#disposed) return;
		const useManualInput = this.#authStorage !== undefined && PASTE_CODE_LOGIN_PROVIDERS.has(providerId);
		this.#selector.stopValidation();
		this.#loggingInProvider = providerId;
		this.#statusLines = [theme.fg("dim", "Starting authentication flow…")];
		this.#authUrl = undefined;
		this.#authLaunchUrl = undefined;
		this.#loginAbort = new AbortController();
		this.#host.restoreFocus();
		this.#host.requestRender();
		try {
			let accountLabel: string | undefined;
			if (this.#providerAuthPort) {
				const credential = await authenticateProvider(this.#providerAuthPort, providerId, {
					signal: this.#loginAbort.signal,
					selectAuthScheme: async (provider, schemes) => {
						const choices = schemes.map((scheme, index) => `${index + 1}) ${scheme}`).join("  ");
						const answer = (
							await this.#showPrompt({
								message: `Choose authentication for ${provider.displayName}: ${choices}`,
							})
						).trim();
						const selectedIndex = Number.parseInt(answer, 10) - 1;
						return schemes[selectedIndex] ?? answer;
					},
					selectOAuthFlow: async provider => {
						const flows = provider.oauthFlows.filter(
							(flow): flow is "browser" | "device" => flow === "browser" || flow === "device",
						);
						if (flows.length <= 1) return flows[0];
						const choices = flows.map((flow, index) => `${index + 1}) ${flow}`).join("  ");
						const answer = (await this.#showPrompt({ message: `Choose OAuth flow: ${choices}` })).trim();
						const selectedIndex = Number.parseInt(answer, 10) - 1;
						const selectedByName = answer === "browser" || answer === "device" ? answer : undefined;
						return (
							flows[selectedIndex] ??
							(selectedByName && flows.includes(selectedByName) ? selectedByName : undefined)
						);
					},
					showAuthorization: session => {
						const url = session.authorizeUrl;
						const instructions = [
							session.instructions,
							session.userCode ? `Code: ${session.userCode}` : undefined,
						].filter((line): line is string => Boolean(line));
						this.#statusLines = instructions.map(line => theme.fg("warning", line));
						if (url) {
							this.#authUrl = url;
							void this.#copyAuthUrl();
							this.host.ctx.openInBrowser(url);
						}
						this.host.requestRender();
					},
					prompt: input =>
						this.#showPrompt({
							message: input.message,
							placeholder: input.placeholder,
							secret: input.secret,
						}),
					showProgress: message => {
						this.#statusLines.push(theme.fg("dim", message));
						this.host.requestRender();
					},
				});
				accountLabel = credential.accountLabel;
			} else {
				const authStorage = this.#authStorage;
				if (!authStorage) {
					throw new Error(`${this.host.identity.displayName} provider setup is unavailable`);
				}
				const identity = await authStorage.login(providerId as OAuthProvider, {
					signal: this.#loginAbort.signal,
					onBrowserSession: captureBrowserSession,
					onAuth: info => {
						this.#authUrl = info.url;
						this.#authLaunchUrl = info.launchUrl && info.launchUrl !== info.url ? info.launchUrl : undefined;
						this.#statusLines = [];
						if (info.instructions) {
							this.#statusLines.push(theme.fg("warning", info.instructions));
						}
						if (useManualInput) {
							this.#statusLines.push(theme.fg("dim", "Paste the returned code or redirect URL when prompted."));
						}
						void this.#copyAuthUrl();
						this.host.ctx.openInBrowser(info.url);
						this.host.requestRender();
					},
					onPrompt: prompt => this.#showPrompt(prompt),
					onProgress: message => {
						this.#statusLines.push(theme.fg("dim", message));
						this.host.requestRender();
					},
					onManualCodeInput: signal =>
						this.#showPrompt({ message: "Paste the authorization code (or full redirect URL):" }, signal),
				});
				accountLabel = identity?.type === "oauth" ? (identity.email ?? identity.accountId) : undefined;
				await this.host.ctx.modelRegistry.refreshProvider(providerId, "online");
			}
			if (this.#disposed) return;
			const account = accountLabel ? ` as ${accountLabel}` : "";
			this.#statusLines = [
				theme.fg("success", `${theme.status.success} Signed in to ${providerId}${account}`),
				theme.fg(
					"dim",
					this.#providerAuthPort
						? `Credentials managed by ${BREADBOARD_PRODUCT_IDENTITY.displayName} auth broker`
						: this.host.nativeAuthStorage
							? "Credentials saved to the shared OMP auth store"
							: `Credentials saved to ${getAgentDbPath()}`,
				),
			];
			this.#authUrl = undefined;
			this.#authLaunchUrl = undefined;
			this.#loggingInProvider = undefined;
			this.#loginAbort = undefined;
			this.#selector.stopValidation();
			this.#selector = this.#createSelector();
			this.#host.restoreFocus();
			this.#host.requestRender();
		} catch (error) {
			if (this.#disposed) return;
			if (this.#loginAbort?.signal.aborted) {
				this.#statusLines = [theme.fg("dim", "Login cancelled.")];
			} else if (error instanceof ProviderAuthError) {
				this.#statusLines = [
					theme.fg("error", `Login failed [${error.code}]: ${error.message}`),
					theme.fg("dim", error.nextAction),
				];
			} else {
				const message = error instanceof Error ? error.message : String(error);
				this.#statusLines = [
					theme.fg("error", `Login failed: ${message}`),
					theme.fg("dim", "Choose another provider or press Esc to continue."),
				];
			}
			this.#authUrl = undefined;
			this.#authLaunchUrl = undefined;
			this.#loggingInProvider = undefined;
			this.#loginAbort = undefined;
			this.#host.restoreFocus();
			this.#host.requestRender();
		}
	}

	async #copyAuthUrl(): Promise<void> {
		const url = this.#authUrl;
		if (!url) return;
		try {
			await this.#host.ctx.copyToClipboard(url);
		} catch {
			// Clipboard integration is best-effort; the full URL remains rendered below.
		}
		this.#host.requestRender();
	}

	#showPrompt(
		prompt: { message: string; placeholder?: string; secret?: boolean },
		signal?: AbortSignal,
	): Promise<string> {
		this.#resolvePrompt("");
		if (signal?.aborted) {
			return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Login input cancelled"));
		}
		const input = new Input();
		input.mask = prompt.secret === true;
		const focusInput = new CopyablePromptInput(input, () => {
			void this.#copyAuthUrl();
		});
		const pending = Promise.withResolvers<string>();
		this.#promptResolve = pending.resolve;
		this.#promptReject = pending.reject;
		this.#prompt = {
			message: prompt.message,
			placeholder: prompt.secret ? undefined : prompt.placeholder,
			input: focusInput,
		};
		if (signal) {
			const onAbort = () => {
				if (this.#promptReject !== pending.reject) return;
				this.#rejectPrompt(signal.reason instanceof Error ? signal.reason : new Error("Login input cancelled"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			this.#promptAbortCleanup = () => signal.removeEventListener("abort", onAbort);
		}
		input.onSubmit = value => {
			focusInput.clear();
			this.#resolvePrompt(value);
		};
		input.onEscape = () => {
			this.#loginAbort?.abort();
			focusInput.clear();
			this.#resolvePrompt("");
		};
		this.#host.setFocus(focusInput);
		this.#host.requestRender();
		return pending.promise;
	}

	#resolvePrompt(value: string): void {
		const resolve = this.#promptResolve;
		this.#prompt?.input.clear();
		if (!resolve) return;
		this.#clearPrompt();
		resolve(value);
	}

	#rejectPrompt(error: Error): void {
		const reject = this.#promptReject;
		if (!reject) return;
		this.#clearPrompt();
		reject(error);
	}

	#clearPrompt(): void {
		this.#promptAbortCleanup?.();
		this.#promptAbortCleanup = undefined;
		this.#promptResolve = undefined;
		this.#promptReject = undefined;
		this.#prompt = undefined;
		this.#host.restoreFocus();
		this.#host.requestRender();
	}
}
