import type { BoundLifecycleE4Client, LifecycleEngineBinding } from "@breadboard/sdk/lifecycle";
import type { BreadboardEngineMode } from "./run-config";

export const LIFECYCLE_STATES = [
	"off",
	"claiming",
	"starting",
	"connecting",
	"handshaking",
	"acquiring-owner",
	"registering-client",
	"compatible-observed",
	"ready",
	"reconnecting",
	"backing-off",
	"draining",
	"restart-stopping",
	"restart-starting",
	"stopping",
	"detaching-client",
	"detached",
	"stopped",
	"failed",
	"restart-blocked",
	"drain-recovery-failed",
	"update-unavailable",
	"ownership-conflict",
	"owner-lease-expired",
	"registration-conflict",
	"registration-expired",
	"incompatible-engine",
	"auth-failed",
	"tls-failed",
	"identity-changed",
	"request-aborted",
	"external-disconnected",
	"remote-disconnected",
	"recovery-needed",
] as const;

export type LifecycleStateName = (typeof LIFECYCLE_STATES)[number];

export type LifecyclePresentationCategory = "off" | "progress" | "observed" | "ready" | "detached" | "stopped" | "failure";

export interface LifecycleStateSemantics {
	readonly failure: boolean;
	readonly retryable: boolean;
	readonly terminal: boolean;
	readonly localOwnedOnly: boolean;
	readonly authorityDiscontinuity: boolean;
	readonly presentation: LifecyclePresentationCategory;
}

/**
 * The single semantic owner for lifecycle state names. Adding a state to
 * LIFECYCLE_STATES requires a corresponding row here.
 */
export const LIFECYCLE_STATE_SEMANTICS = {
	off: {
		failure: false,
		retryable: false,
		terminal: true,
		localOwnedOnly: false,
		authorityDiscontinuity: false,
		presentation: "off",
	},
	claiming: {
		failure: false,
		retryable: false,
		terminal: false,
		localOwnedOnly: true,
		authorityDiscontinuity: false,
		presentation: "progress",
	},
	starting: {
		failure: false,
		retryable: false,
		terminal: false,
		localOwnedOnly: true,
		authorityDiscontinuity: false,
		presentation: "progress",
	},
	connecting: {
		failure: false,
		retryable: false,
		terminal: false,
		localOwnedOnly: false,
		authorityDiscontinuity: false,
		presentation: "progress",
	},
	handshaking: {
		failure: false,
		retryable: false,
		terminal: false,
		localOwnedOnly: false,
		authorityDiscontinuity: false,
		presentation: "progress",
	},
	"acquiring-owner": {
		failure: false,
		retryable: false,
		terminal: false,
		localOwnedOnly: true,
		authorityDiscontinuity: false,
		presentation: "progress",
	},
	"registering-client": {
		failure: false,
		retryable: false,
		terminal: false,
		localOwnedOnly: false,
		authorityDiscontinuity: false,
		presentation: "progress",
	},
	"compatible-observed": {
		failure: false,
		retryable: false,
		terminal: false,
		localOwnedOnly: false,
		authorityDiscontinuity: false,
		presentation: "observed",
	},
	ready: {
		failure: false,
		retryable: false,
		terminal: false,
		localOwnedOnly: false,
		authorityDiscontinuity: true,
		presentation: "ready",
	},
	reconnecting: {
		failure: false,
		retryable: true,
		terminal: false,
		localOwnedOnly: false,
		authorityDiscontinuity: false,
		presentation: "progress",
	},
	"backing-off": {
		failure: false,
		retryable: true,
		terminal: false,
		localOwnedOnly: true,
		authorityDiscontinuity: true,
		presentation: "progress",
	},
	draining: {
		failure: false,
		retryable: false,
		terminal: false,
		localOwnedOnly: true,
		authorityDiscontinuity: false,
		presentation: "progress",
	},
	"restart-stopping": {
		failure: false,
		retryable: false,
		terminal: false,
		localOwnedOnly: true,
		authorityDiscontinuity: true,
		presentation: "progress",
	},
	"restart-starting": {
		failure: false,
		retryable: false,
		terminal: false,
		localOwnedOnly: true,
		authorityDiscontinuity: true,
		presentation: "progress",
	},
	stopping: {
		failure: false,
		retryable: false,
		terminal: false,
		localOwnedOnly: true,
		authorityDiscontinuity: false,
		presentation: "progress",
	},
	"detaching-client": {
		failure: false,
		retryable: false,
		terminal: false,
		localOwnedOnly: false,
		authorityDiscontinuity: false,
		presentation: "progress",
	},
	detached: {
		failure: false,
		retryable: false,
		terminal: true,
		localOwnedOnly: false,
		authorityDiscontinuity: false,
		presentation: "detached",
	},
	stopped: {
		failure: false,
		retryable: false,
		terminal: true,
		localOwnedOnly: true,
		authorityDiscontinuity: false,
		presentation: "stopped",
	},
	failed: {
		failure: true,
		retryable: false,
		terminal: true,
		localOwnedOnly: false,
		authorityDiscontinuity: false,
		presentation: "failure",
	},
	"restart-blocked": {
		failure: true,
		retryable: false,
		terminal: true,
		localOwnedOnly: true,
		authorityDiscontinuity: false,
		presentation: "failure",
	},
	"drain-recovery-failed": {
		failure: true,
		retryable: false,
		terminal: true,
		localOwnedOnly: true,
		authorityDiscontinuity: false,
		presentation: "failure",
	},
	"update-unavailable": {
		failure: true,
		retryable: false,
		terminal: true,
		localOwnedOnly: true,
		authorityDiscontinuity: false,
		presentation: "failure",
	},
	"ownership-conflict": {
		failure: true,
		retryable: false,
		terminal: true,
		localOwnedOnly: true,
		authorityDiscontinuity: false,
		presentation: "failure",
	},
	"owner-lease-expired": {
		failure: true,
		retryable: false,
		terminal: true,
		localOwnedOnly: true,
		authorityDiscontinuity: false,
		presentation: "failure",
	},
	"registration-conflict": {
		failure: true,
		retryable: false,
		terminal: true,
		localOwnedOnly: false,
		authorityDiscontinuity: false,
		presentation: "failure",
	},
	"registration-expired": {
		failure: true,
		retryable: false,
		terminal: true,
		localOwnedOnly: false,
		authorityDiscontinuity: false,
		presentation: "failure",
	},
	"incompatible-engine": {
		failure: true,
		retryable: false,
		terminal: true,
		localOwnedOnly: false,
		authorityDiscontinuity: false,
		presentation: "failure",
	},
	"auth-failed": {
		failure: true,
		retryable: false,
		terminal: true,
		localOwnedOnly: false,
		authorityDiscontinuity: false,
		presentation: "failure",
	},
	"tls-failed": {
		failure: true,
		retryable: false,
		terminal: true,
		localOwnedOnly: false,
		authorityDiscontinuity: false,
		presentation: "failure",
	},
	"identity-changed": {
		failure: true,
		retryable: false,
		terminal: true,
		localOwnedOnly: false,
		authorityDiscontinuity: false,
		presentation: "failure",
	},
	"request-aborted": {
		failure: true,
		retryable: false,
		terminal: true,
		localOwnedOnly: false,
		authorityDiscontinuity: false,
		presentation: "failure",
	},
	"external-disconnected": {
		failure: true,
		retryable: false,
		terminal: true,
		localOwnedOnly: false,
		authorityDiscontinuity: false,
		presentation: "failure",
	},
	"remote-disconnected": {
		failure: true,
		retryable: false,
		terminal: true,
		localOwnedOnly: false,
		authorityDiscontinuity: false,
		presentation: "failure",
	},
	"recovery-needed": {
		failure: true,
		retryable: false,
		terminal: true,
		localOwnedOnly: false,
		authorityDiscontinuity: false,
		presentation: "failure",
	},
} as const satisfies Readonly<Record<LifecycleStateName, LifecycleStateSemantics>>;

type SemanticBooleanField = "failure" | "retryable" | "terminal" | "localOwnedOnly" | "authorityDiscontinuity";
type LifecycleStateNamesWith<Field extends SemanticBooleanField> = {
	[Name in LifecycleStateName]: (typeof LIFECYCLE_STATE_SEMANTICS)[Name][Field] extends true ? Name : never;
}[LifecycleStateName];

function namesWithSemanticFlag<Field extends SemanticBooleanField>(
	field: Field,
): readonly LifecycleStateNamesWith<Field>[] {
	// The filter and the mapped type above are two views of the same table row.
	return Object.freeze(
		LIFECYCLE_STATES.filter(name => LIFECYCLE_STATE_SEMANTICS[name][field]),
	) as readonly LifecycleStateNamesWith<Field>[];
}

export type LifecycleFailureStateName = LifecycleStateNamesWith<"failure">;
export const LIFECYCLE_FAILURE_STATES = namesWithSemanticFlag("failure");
export type LifecycleTerminalStateName = LifecycleStateNamesWith<"terminal">;
export const LIFECYCLE_TERMINAL_STATES = namesWithSemanticFlag("terminal");
export type LifecycleRetryableStateName = LifecycleStateNamesWith<"retryable">;
export const LIFECYCLE_RETRYABLE_STATES = namesWithSemanticFlag("retryable");
export type LifecycleLocalOwnedOnlyStateName = LifecycleStateNamesWith<"localOwnedOnly">;
export const LIFECYCLE_LOCAL_OWNED_ONLY_STATES = namesWithSemanticFlag("localOwnedOnly");
export type LifecycleAuthorityDiscontinuityStateName = LifecycleStateNamesWith<"authorityDiscontinuity">;
export const LIFECYCLE_AUTHORITY_DISCONTINUITY_STATES = namesWithSemanticFlag("authorityDiscontinuity");

export function isLifecycleFailureState(name: LifecycleStateName): name is LifecycleFailureStateName {
	return LIFECYCLE_STATE_SEMANTICS[name].failure;
}

export function isLifecycleTerminalState(name: LifecycleStateName): name is LifecycleTerminalStateName {
	return LIFECYCLE_STATE_SEMANTICS[name].terminal;
}

export function isLifecycleRetryableState(name: LifecycleStateName): name is LifecycleRetryableStateName {
	return LIFECYCLE_STATE_SEMANTICS[name].retryable;
}

export function isLifecycleLocalOwnedOnlyState(name: LifecycleStateName): name is LifecycleLocalOwnedOnlyStateName {
	return LIFECYCLE_STATE_SEMANTICS[name].localOwnedOnly;
}

export function isLifecycleAuthorityDiscontinuityState(
	name: LifecycleStateName,
): name is LifecycleAuthorityDiscontinuityStateName {
	return LIFECYCLE_STATE_SEMANTICS[name].authorityDiscontinuity;
}

export function lifecyclePresentationCategory(name: LifecycleStateName): LifecyclePresentationCategory {
	return LIFECYCLE_STATE_SEMANTICS[name].presentation;
}

export interface LifecycleState {
	readonly name: LifecycleStateName;
	readonly mode: BreadboardEngineMode;
	readonly attempt: number;
	readonly reason?: LifecycleReason;
}

export type LifecycleReason =
	| "engine_mode_off"
	| "mode_forbidden"
	| "artifact_update_not_governed"
	| "engine_artifact_unavailable"
	| "engine_artifact_mismatch"
	| "authority_record_invalid"
	| "authority_store_unavailable"
	| "ownership_conflict"
	| "identity_changed"
	| "owner_lease_expired"
	| "registration_conflict"
	| "registration_expired"
	| "endpoint_unreachable"
	| "incompatible_engine"
	| "auth_failed"
	| "tls_failed"
	| "request_aborted"
	| "restart_budget_exhausted"
	| "drain_denied"
	| "drain_recovery_failed"
	| "process_identity_unavailable"
	| "process_control_failed"
	| "session_slice_not_landed";

export interface LifecycleReadyHandle {
	readonly mode: Exclude<BreadboardEngineMode, "off">;
	readonly binding: LifecycleEngineBinding;
	readonly lifecycleClient: BoundLifecycleE4Client;
	readonly requestFetch: typeof fetch;
	readonly registration: {
		readonly id: string;
		readonly generation: number;
		readonly clientInstanceId: string;
		readonly admissionEpoch: number;
		readonly expiresAtUnix: number;
	};
	readonly ownerGeneration?: number;
}

export interface LifecycleObservedHandle {
	readonly mode: Exclude<BreadboardEngineMode, "off">;
	readonly binding: LifecycleEngineBinding;
}

export type LifecycleResult =
	| { readonly kind: "off"; readonly state: LifecycleState & { readonly name: "off" } }
	| {
			readonly kind: "observed";
			readonly state: LifecycleState & { readonly name: "compatible-observed" };
			readonly handle: LifecycleObservedHandle;
	  }
	| {
			readonly kind: "ready";
			readonly state: LifecycleState & { readonly name: "ready" };
			readonly handle: LifecycleReadyHandle;
	  }
	| { readonly kind: "detached"; readonly state: LifecycleState & { readonly name: "detached" } }
	| { readonly kind: "stopped"; readonly state: LifecycleState & { readonly name: "stopped" } }
	| {
			readonly kind: "failure";
			readonly state: LifecycleState & {
				readonly name: LifecycleFailureStateName;
				readonly reason: LifecycleReason;
			};
	  };


export function lifecycleState(
	mode: BreadboardEngineMode,
	name: LifecycleStateName,
	attempt = 0,
	reason?: LifecycleReason,
): LifecycleState {
	if (isLifecycleLocalOwnedOnlyState(name) && mode !== "local-owned")
		throw new Error(`lifecycle state ${name} is forbidden in ${mode}`);
	if (mode === "off" && name !== "off" && reason !== "mode_forbidden")
		throw new Error(`off mode cannot enter lifecycle state ${name}`);
	if (
		isLifecycleTerminalState(name) &&
		name !== "off" &&
		name !== "detached" &&
		name !== "stopped" &&
		reason === undefined
	) {
		throw new Error(`terminal lifecycle state ${name} requires a reason`);
	}
	return Object.freeze({ name, mode, attempt, ...(reason === undefined ? {} : { reason }) });
}

function lifecycleFailureState(
	mode: BreadboardEngineMode,
	name: LifecycleFailureStateName,
	reason: LifecycleReason,
	attempt: number,
): LifecycleState & { readonly name: LifecycleFailureStateName; readonly reason: LifecycleReason } {
	lifecycleState(mode, name, attempt, reason);
	return Object.freeze({ name, mode, attempt, reason });
}

export function lifecycleFailure(
	mode: BreadboardEngineMode,
	name: LifecycleFailureStateName,
	reason: LifecycleReason,
	attempt = 0,
): LifecycleResult {
	return {
		kind: "failure",
		state: lifecycleFailureState(mode, name, reason, attempt),
	};
}
