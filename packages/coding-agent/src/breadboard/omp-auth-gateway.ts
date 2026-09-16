import { createHash, randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { startAuthGateway, type AuthGatewayServerHandle } from "@oh-my-pi/pi-ai/auth-gateway";
import type { AuthStorage } from "../session/auth-storage";
import type { ModelRegistry } from "../config/model-registry";
import type { Model } from "@oh-my-pi/pi-ai";

import type { BreadboardGatewayBinding } from "./lifecycle/run-config";

export interface BreadboardOmpGateway {
	readonly binding: BreadboardGatewayBinding;
	close(): Promise<void>;
}

export function resolveBreadboardOmpAgentDir(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const directory = value.trim();
	if (!directory || !isAbsolute(directory)) {
		throw new Error("BREADBOARD_OMP_AGENT_DIR must name an absolute existing OMP agent directory");
	}
	try {
		const canonical = realpathSync(directory);
		if (statSync(canonical).isDirectory() && statSync(join(canonical, "agent.db")).isFile()) return canonical;
	} catch {
		// Do not let auth discovery create an empty replacement for a mistyped vault.
	}
	throw new Error("BREADBOARD_OMP_AGENT_DIR must contain an existing OMP agent.db");
}

function gatewayIdentity(url: string, token: string): `sha256:${string}` {
	return `sha256:${createHash("sha256")
		.update("breadboard-omp-gateway-v1\0")
		.update(url)
		.update("\0")
		.update(token)
		.digest("hex")}`;
}

function exactAvailableModel(
	modelRegistry: Pick<ModelRegistry, "getAvailable">,
	requestedId: string,
): Model | undefined {
	return modelRegistry.getAvailable().find(model => `${model.provider}/${model.id}` === requestedId);
}

/**
 * Start the loopback gateway used by a local-owned BreadBoard engine.
 *
 * The registry is deliberately queried through its authenticated projection:
 * unauthenticated providers never enter `/v1/models`, and request routing only
 * accepts an exact provider-qualified id.
 */
export function startBreadboardOmpGateway(
	authStorage: AuthStorage,
	modelRegistry: Pick<ModelRegistry, "getAvailable">,
): BreadboardOmpGateway {
	const token = randomBytes(32).toString("base64url");
	let server: AuthGatewayServerHandle;
	try {
		server = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			storage: authStorage,
			resolveModel: requestedId => exactAvailableModel(modelRegistry, requestedId),
			listModels: () => modelRegistry.getAvailable(),
			version: "breadboard",
		});
	} catch (error) {
		throw new Error("BreadBoard OMP auth gateway failed to bind", { cause: error });
	}
	let closed = false;
	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		await server.close();
	};
	return Object.freeze({
		binding: Object.freeze({ url: server.url, token, identity: gatewayIdentity(server.url, token) }),
		close,
	});
}
