/**
 * Harness exposure contract shared by the harness hub and lock-derived palette (bb-ewnk.4) and the
 * BreadBoard settings tab, status segment and welcome identity (bb-ewnk.5).
 *
 * A BreadBoard session is pinned to one effective harness lock; "switching" means starting a new
 * session open and once per generation change (`bb-2j1u.22/proposal.md` §2.1-2.5, performance guardrail §5). It never runs on the frame
 * path: renderers read `current()` synchronously and re-render from `subscribe` notifications.
 *
 * The SDK AgentSession event union exposes no public effective-lock or
 * generation-change event. Native sessions publish generations through their
 * live harness state; bridge sessions continue to refresh from the control plane.
 */

export interface HarnessProvenance {
	/** Source file that defines the value (`harness.explain`). */
	readonly source: string;
	/** 1-based line in `source`, when the engine reports one. */
	readonly line: number | null;
}

export interface HarnessSnapshot {
	/** Harness id as the engine names it (`harness.get`/`harness.list`). */
	readonly harnessId: string;
	/** Display name from the definition; equals `harnessId` when the definition has no name. */
	readonly name: string;
	/** Effective lock hash bound to the session (`effective_lock_hash`), when reported. */
	readonly lockHash: string | null;
	/** Identity verified by comparing the loaded lock graph hash to `lockHash`. */
	readonly verifiedIdentity?: { readonly harnessId: string; readonly lockHash: string } | null;
	/** Session generation number encoded as a string for bridge/TUI compatibility. */
	readonly generation: string | null;
	readonly mode: string | null;
	/** Effective lock as returned by `harness_lock.get`; consumers read known sections defensively. */
	readonly lock: Readonly<Record<string, unknown>> | null;
	/** `harness.explain` provenance keyed by dotted path. */
	readonly provenance: Readonly<Record<string, HarnessProvenance>>;

	/** `Date.now()` when the snapshot was loaded. */
	readonly loadedAt: number;
}
export interface HarnessCommandSpec {
	readonly name: string;
	/** Effective-lock section that admitted or rejected the command. */
	readonly source: string;
	readonly enabled: boolean;
	/** Why the command is dimmed or unavailable, when it is not enabled. */
	readonly reason?: string;
}
export type HarnessRefreshReason = "session-open" | "harness-use" | "generation-change" | "manual";

export interface HarnessPort {
	/** Last loaded snapshot; `null` before the first successful load or when no harness is bound. */
	current(): HarnessSnapshot | null;
	/** Reload from the engine. Resolves to the new snapshot, or `null` when the engine has none. */
	refresh(reason: HarnessRefreshReason): Promise<HarnessSnapshot | null>;
	/** Notified after every `refresh` that changed the snapshot; returns the unsubscribe function. */
	subscribe(listener: (snapshot: HarnessSnapshot | null) => void): () => void;
	/** Update the source identity used by the next snapshot refresh. */
	/** Reload the workspace spec and publish its next generation at the next turn boundary. */
	readonly reloadNativeHarness?: () => Promise<HarnessSnapshot | null>;
	readonly setHarnessId?: (harnessId: string) => void;
	/** Apply a live engine mode override to the bound session. */
	readonly setSessionMode?: (mode: string) => Promise<void>;
	/** Apply a live engine role override to the bound session. */
	readonly setSessionRole?: (role: string, model?: string) => Promise<void>;
	/** Apply a live engine model override to the bound session. */
	readonly setSessionModel?: (model: string) => Promise<void>;
	readonly controlClient?: {
		getHarness?(id: string): Promise<unknown>;
		validateHarness?(id: string): Promise<unknown>;
		explainHarness?(id: string): Promise<unknown>;
		lockHarness?(id: string): Promise<unknown>;
		getHarnessLock?(id: string): Promise<unknown>;
	};
	readonly setSessionSkills?: (skills: readonly string[]) => Promise<void>;
	/**
	 * List harness definitions from the current BreadBoard engine workspace.
	 * The optional directory is forwarded to the public harness operation.
	 */
	readonly listHarnessChoices?: (
		directory?: string,
	) => Promise<readonly { readonly id: string; readonly name: string; readonly path: string }[]>;
	/**
	 * Query the live runtime description for a session (E12 Phase B).
	 * Returns null when the underlying engine does not provide a runtime.describe operation.
	 */
	readonly describeRuntime?: (sessionId?: string) => Promise<unknown>;
}
