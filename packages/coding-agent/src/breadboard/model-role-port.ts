export interface ModelRolePort {
	getModelRoles(input?: { readonly harnessId?: string; readonly lockId?: string }): Promise<Record<string, unknown>>;
	validateModelRoles(config: Record<string, unknown>): Promise<Record<string, unknown>>;
	resolveModelRole(
		role: string,
		input?: { readonly harnessId?: string; readonly lockId?: string; readonly checkAuth?: boolean },
	): Promise<Record<string, unknown>>;
}

export interface BreadboardModelRoleClient {
	readonly [key: string]: unknown;
	readonly getModelRoles?: (input?: Record<string, unknown>) => Promise<Record<string, unknown>>;
	readonly validateModelRoles?: (config: Record<string, unknown>) => Promise<Record<string, unknown>>;
	readonly resolveModelRole?: (role: string, input?: Record<string, unknown>) => Promise<Record<string, unknown>>;
}
export class ModelRoleFlowUnavailableError extends Error {
	readonly code = "model_role_sdk_unavailable" as const;
}

/** Keeps role resolution behind the SDK client, even while older SDK artifacts lack role routes. */
export function createBreadboardModelRolePort(client: BreadboardModelRoleClient): ModelRolePort {
	return {
		async getModelRoles(input) {
			if (!client.getModelRoles) throw new ModelRoleFlowUnavailableError("No model-role endpoint is available");
			return client.getModelRoles(input);
		},
		async validateModelRoles(config) {
			if (!client.validateModelRoles)
				throw new ModelRoleFlowUnavailableError("No model-role validation endpoint is available");
			return client.validateModelRoles(config);
		},
		async resolveModelRole(role, input) {
			if (!client.resolveModelRole)
				throw new ModelRoleFlowUnavailableError("No model-role resolution endpoint is available");
			return client.resolveModelRole(role, input);
		},
	};
}
