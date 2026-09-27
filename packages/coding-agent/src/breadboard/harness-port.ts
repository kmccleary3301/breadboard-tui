/**
 * Harness exposure contract shared by the harness hub and lock-derived palette (bb-ewnk.4) and the
 * BreadBoard settings tab, status segment and welcome identity (bb-ewnk.5).
 *
 * A BreadBoard session is pinned to its effective harness lock loaded at launch. Workspace
 * generations are published through the native loader's live harness state. Renderers read
 * `current()` synchronously and re-render from `subscribe` notifications.
 */

export interface HarnessProvenance {
	/** Source file that defines the value (`harness.explain`). */
	readonly source: string;
	/** 1-based line in `source`, when the engine reports one. */
	readonly line: number | null;
}

export interface HarnessSnapshot {
	/** Harness id (`harness.get` / built-in harness id). */
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
	/** Refresh the current snapshot. Resolves to the snapshot, or `null` when none is loaded. */
	refresh(reason: HarnessRefreshReason): Promise<HarnessSnapshot | null>;
	/** Notified after every snapshot change; returns the unsubscribe function. */
	subscribe(listener: (snapshot: HarnessSnapshot | null) => void): () => void;
	/** Reload the workspace spec and publish its next generation at the next turn boundary. */
	readonly reloadNativeHarness?: () => Promise<HarnessSnapshot | null>;
}
