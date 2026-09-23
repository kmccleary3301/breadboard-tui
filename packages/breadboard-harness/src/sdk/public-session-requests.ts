/** Mirrors the pyref public SDK request schemas: SessionStartRequest and SessionCancelRequest. */
export interface PublicSessionStartRequest {
	readonly lock_id: string;
	readonly task: string;
	readonly session_id?: string | null;
}

export interface PublicSessionCancelRequest {
	readonly reason?: string;
}
