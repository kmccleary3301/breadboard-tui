export interface ModelRoleResolutionInput {
	readonly model_roles: Record<string, unknown>;
	readonly role_overrides?: Record<string, unknown> | null;
	readonly session_started?: boolean;
}

export interface ModelRoleResolutionResult {
	readonly lock: Record<string, unknown>;
	readonly lock_hash: string;
}

export interface ModelRolePort {
	resolveModelRoles(input: ModelRoleResolutionInput): Promise<ModelRoleResolutionResult>;
}

/** Keeps role resolution behind the SDK client boundary. */
export function createBreadboardModelRolePort(client: { resolveModelRoles(input: ModelRoleResolutionInput): Promise<ModelRoleResolutionResult> }): ModelRolePort {
	return {
		resolveModelRoles(input) {
			return client.resolveModelRoles(input);
		},
	};
}
