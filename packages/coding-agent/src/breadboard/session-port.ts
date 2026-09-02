import type {
	AttachSessionRequest,
	CancelReceipt,
	CancelTurnRequest,
	CreateSessionRequest,
	LoggedSessionEvent,
	ObserveEvents,
	PermissionDecisionReceipt,
	RespondPermissionRequest,
	SessionId,
	SessionSnapshot,
	SubmitReceipt,
	SubmitTextTurn,
	TurnId,
} from "@breadboard/sdk/session";

export type {
	AttachSessionRequest,
	CancelReceipt,
	CancelTurnRequest,
	CreateSessionRequest,
	LoggedSessionEvent,
	ObserveEvents,
	PermissionDecisionReceipt,
	RespondPermissionRequest,
	SessionId,
	SessionSnapshot,
	SubmitReceipt,
	SubmitTextTurn,
	TurnId,
};

/**
 * Product session creation keeps the generated canonical contract at the
 * adapter boundary while allowing the packaged backend profile to be selected
 * by omission.
 */
export type BreadboardCreateSessionRequest = Omit<CreateSessionRequest, "configPath"> & {
	readonly configPath?: string;
	readonly workspace: string;
};

export type OpenSession =
	| { readonly kind: "create"; readonly request: BreadboardCreateSessionRequest }
	| { readonly kind: "attach"; readonly sessionId: AttachSessionRequest["sessionId"] };

/**
 * The session contract owned by the BreadBoard adapter boundary.
 *
 * Canonical SDK runtimes are adapted to this interface before they leave the
 * BreadBoard port, so downstream OMP code never depends on SDK runtime names.
 */
export interface OpenedSession {
	readonly sessionId: SessionId;
	snapshot(): Promise<SessionSnapshot>;
	submit(input: SubmitTextTurn): Promise<SubmitReceipt>;
	cancel(request: CancelTurnRequest): Promise<CancelReceipt>;
	respondPermission(request: RespondPermissionRequest): Promise<PermissionDecisionReceipt>;
	events(request?: ObserveEvents): AsyncGenerator<LoggedSessionEvent, void, void>;
	close(): Promise<void>;
}

export interface BreadboardSessionPort {
	open(target: OpenSession, signal?: AbortSignal): Promise<OpenedSession>;
}

export type SubmitRequest = SubmitTextTurn;
export type SubmitResult = SubmitReceipt;
