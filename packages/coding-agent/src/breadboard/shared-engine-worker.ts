import * as net from "node:net";
import { chmodSync, realpathSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage } from "../sdk";
import { createProductionLifecycleSupervisor } from "./lifecycle/lifecycle-production";
import type { LifecycleReason, LifecycleResult, LifecycleStateName } from "./lifecycle/lifecycle-state";
import { resolveBreadboardRunConfig } from "./lifecycle/run-config";
import { startBreadboardOmpGateway } from "./omp-auth-gateway";
import {
	parseSharedEngineLaunch,
	sharedEngineKey,
	SHARED_ENGINE_CONFIG_ENV,
	SHARED_ENGINE_READY_PATTERN,
	SHARED_ENGINE_SCHEMA_VERSION,
	SHARED_ENGINE_SOCKET_ENV,
	type SharedEngineEvent,
	type SharedEngineInfo,
} from "./shared-engine-protocol";

const encoder = new TextEncoder();
/** Retry policy for a drain the supervisor denied; attempts reset when a client event re-arms cleanup. */
export interface SharedEngineCleanupRetryPolicy {
	readonly initialDelayMs: number;
	readonly maxDelayMs: number;
	readonly maxAttempts: number;
}
const DEFAULT_CLEANUP_RETRY: SharedEngineCleanupRetryPolicy = {
	initialDelayMs: 1_000,
	maxDelayMs: 60_000,
	maxAttempts: 8,
};
const CLEANUP_GRACE_MS = 100;
const FIRST_LEASE_TIMEOUT_MS = 30_000;

async function allocateLoopbackEndpoint(): Promise<string> {
	const server = net.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
	if (address === null || typeof address === "string") throw new Error("shared engine endpoint allocation failed");
	return `http://127.0.0.1:${address.port}`;
}

function jsonLine(event: SharedEngineEvent): Uint8Array {
	return encoder.encode(`${JSON.stringify(event)}\n`);
}

interface SharedEngineLeaseServerOptions {
	readonly info: SharedEngineInfo;
	readonly closeEngine: () => Promise<LifecycleResult>;
	readonly refreshAuth: () => Promise<void>;
	readonly cleanupRetry?: SharedEngineCleanupRetryPolicy;
}

/** Terminal cleanup outcome: the engine owner was retained and no further attempt is scheduled. */
export interface SharedEngineCleanupAbandoned {
	readonly kind: "cleanup_abandoned";
	readonly attempts: number;
	readonly state?: LifecycleStateName;
	readonly reason?: LifecycleReason;
	readonly error?: string;
}

/** Owns admission and client lifetimes; engine shutdown remains authenticated by the supervisor. */
export class SharedEngineLeaseServer {
	readonly #leases = new Set<() => void>();
	readonly #closed = Promise.withResolvers<void>();
	readonly closed = this.#closed.promise;
	#server: Server | undefined;
	#socketPath: string | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#draining = false;
	#retiring = false;
	#finished = false;
	#cleanupAttempts = 0;
	#abandoned: SharedEngineCleanupAbandoned | undefined;

	/** Set once cleanup stops retrying; cleared when a new lease or retirement re-arms it. */
	get cleanupAbandoned(): SharedEngineCleanupAbandoned | undefined {
		return this.#abandoned;
	}

	constructor(private readonly options: SharedEngineLeaseServerOptions) {}

	async start(socketPath: string): Promise<void> {
		if (this.#server) throw new Error("shared engine lease server already started");
		// The broker serializes starts. Never unlink a potentially live worker's socket.
		const server = createServer((request, response) => this.#handle(request, response));
		server.setTimeout(0);
		this.#server = server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => {
				server.off("error", reject);
				resolve();
			});
		});
		this.#socketPath = socketPath;
		chmodSync(socketPath, 0o600);
		this.#scheduleCleanup(FIRST_LEASE_TIMEOUT_MS);
	}

	retire(): void {
		this.#retiring = true;
		this.#rearmCleanup();
		this.#scheduleCleanup(CLEANUP_GRACE_MS);
	}

	#rearmCleanup(): void {
		this.#cleanupAttempts = 0;
		this.#abandoned = undefined;
	}

	#handle(request: IncomingMessage, response: ServerResponse): void {
		if (this.#draining || this.#retiring || this.#finished) {
			response.writeHead(503).end("shared engine is stopping");
			return;
		}
		const pathname = new URL(request.url ?? "/", "http://shared-engine.local").pathname;
		if (request.method === "GET" && pathname === "/info")
			response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(this.options.info));
		else if (request.method === "GET" && pathname === "/lease") this.#lease(request, response);
		else if (request.method === "POST" && pathname === "/refresh") void this.#refresh(response);
		else response.writeHead(404).end("not found");
	}

	async #refresh(response: ServerResponse): Promise<void> {
		try {
			await this.options.refreshAuth();
			response.writeHead(204).end();
		} catch (error) {
			logger.warn("BreadBoard shared engine auth refresh failed", { error: String(error) });
			response.writeHead(500).end("auth refresh failed");
		}
	}

	#lease(request: IncomingMessage, response: ServerResponse): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#rearmCleanup();
		let released = false;
		const close = (): void => {
			if (released) return;
			released = true;
			this.#leases.delete(close);
			this.#scheduleCleanup(CLEANUP_GRACE_MS);
		};
		const send = (event: SharedEngineEvent): void => {
			if (!released) response.write(jsonLine(event));
		};
		this.#leases.add(close);
		response.once("close", close);
		request.socket.once("close", close);
		request.once("error", close);
		response.once("error", close);
		response.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
		send({ kind: "ready", info: this.options.info });
	}

	#scheduleCleanup(delay: number): void {
		if (this.#leases.size > 0 || this.#draining || this.#finished || this.#abandoned) return;
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#cleanup();
		}, delay);
	}

	async #cleanup(): Promise<void> {
		if (this.#leases.size > 0 || this.#draining || this.#finished || this.#abandoned) return;
		this.#draining = true;
		this.#cleanupAttempts += 1;
		let outcome: Omit<SharedEngineCleanupAbandoned, "kind" | "attempts"> | undefined;
		try {
			const result = await this.options.closeEngine();
			if (result.kind !== "stopped") {
				outcome = { state: result.state.name, reason: result.state.reason };
				return;
			}
			this.#finished = true;
			if (this.#server) {
				const server = this.#server;
				await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
			}
			if (this.#socketPath) rmSync(this.#socketPath, { force: true });
			this.#closed.resolve();
		} catch (error) {
			logger.error("BreadBoard shared engine cleanup failed", { error: String(error) });
			if (this.#finished) this.#closed.reject(error);
			else outcome = { error: String(error) };
		} finally {
			this.#draining = false;
			// A denied drain did not stop the engine. Admissions stay open between attempts,
			// retaining owner renewal and the gateway while external clients remain.
			if (!this.#finished && outcome) this.#retryOrAbandon(outcome);
		}
	}

	#retryOrAbandon(outcome: Omit<SharedEngineCleanupAbandoned, "kind" | "attempts">): void {
		const policy = this.options.cleanupRetry ?? DEFAULT_CLEANUP_RETRY;
		// Only contention (drain_denied) or a thrown attempt can clear by waiting; other refusals,
		// such as drain_recovery_failed, require operator recovery and must not be re-driven.
		const retryable = outcome.reason === "drain_denied" || outcome.error !== undefined;
		if (retryable && this.#cleanupAttempts < policy.maxAttempts) {
			logger.warn("BreadBoard shared engine cleanup retained its owner", {
				...outcome,
				attempt: this.#cleanupAttempts,
			});
			const delay = Math.min(policy.initialDelayMs * 2 ** (this.#cleanupAttempts - 1), policy.maxDelayMs);
			this.#scheduleCleanup(delay);
			return;
		}
		this.#abandoned = { kind: "cleanup_abandoned", attempts: this.#cleanupAttempts, ...outcome };
		const { info } = this.options;
		logger.error("BreadBoard shared engine cleanup abandoned; the engine owner is retained", {
			...this.#abandoned,
			engineKey: info.key,
			engineInstanceId: info.engineInstanceId,
			engineBootId: info.engineBootId,
			enginePid: info.pid,
			osProcessStartToken: info.osProcessStartToken,
		});
	}
}

export async function startSharedBreadboardEngineFromEnvironment(): Promise<void> {
	const socketPath = Bun.env[SHARED_ENGINE_SOCKET_ENV];
	const launchJson = Bun.env[SHARED_ENGINE_CONFIG_ENV];
	if (!socketPath || !isAbsolute(socketPath) || !launchJson)
		throw new Error("shared engine worker requires an absolute socket and launch configuration");
	const launch = parseSharedEngineLaunch(JSON.parse(launchJson));
	const workspacePath = realpathSync(launch.workspacePath);
	const agentDir = realpathSync(launch.agentDir);
	if (realpathSync(getAgentDir()) !== agentDir)
		throw new Error("shared engine worker profile does not match its launch authority");
	let authStorage: Awaited<ReturnType<typeof discoverAuthStorage>> | undefined;
	let registry: ModelRegistry | undefined;
	let gateway: ReturnType<typeof startBreadboardOmpGateway> | undefined;
	let supervisor: ReturnType<typeof createProductionLifecycleSupervisor> | undefined;
	let host: SharedEngineLeaseServer | undefined;
	let interrupted = false;
	let engineStopped = false;
	const onSignal = (): void => {
		interrupted = true;
		if (host) host.retire();
		else supervisor?.abort();
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	try {
		const settings = await Settings.init({ cwd: workspacePath, agentDir });
		if (launch.ompAgentDir !== undefined) {
			authStorage = await discoverAuthStorage(launch.ompAgentDir);
			await authStorage.reload();
			registry = new ModelRegistry(authStorage, undefined, {
				settings,
				ignoreLocalModelConfig: true,
			});
			await registry.hydrateCredentialScopedModelCaches();
			gateway = startBreadboardOmpGateway(authStorage, registry);
		}
		if (interrupted) throw new Error("shared engine startup interrupted");
		const endpoint = launch.derivedEndpoint ? await allocateLoopbackEndpoint() : undefined;
		const config = resolveBreadboardRunConfig({
			selectedConfig: launch.selectedConfig,
			workspacePath,
			...(endpoint === undefined ? {} : { endpointOverride: endpoint }),
			environment: { BREADBOARD_PRODUCT: "1" },
		});
		if (config.mode !== "local-owned" || config.ownerExitPolicy !== "attached")
			throw new Error("shared engine requires attached local-owned configuration");
		const lifecycleConfig = gateway ? Object.freeze({ ...config, gateway: gateway.binding }) : config;
		supervisor = createProductionLifecycleSupervisor(
			lifecycleConfig,
			state => {
				logger.debug("BreadBoard shared engine lifecycle", { state: state.name, reason: state.reason });
			},
			launch.stateNamespaceKey,
		);
		const connected = await supervisor.connect();
		if (connected.kind !== "ready")
			throw new Error(
				`shared engine startup failed: ${connected.state.name} (${connected.state.reason ?? connected.kind})`,
			);
		const owner = supervisor;
		const binding = connected.handle.binding;
		host = new SharedEngineLeaseServer({
			info: {
				schemaVersion: SHARED_ENGINE_SCHEMA_VERSION,
				key: sharedEngineKey(launch),
				endpoint: binding.endpoint,
				engineInstanceId: binding.engineInstanceId,
				engineBootId: binding.engineBootId,
				pid: binding.process.pid,
				osProcessStartToken: binding.process.osProcessStartToken,
			},
			closeEngine: () => owner.close({ consumerClosed: true, preserveOnDrainConflict: true }),
			refreshAuth: async () => {
				await authStorage?.credentials.reload();
				await registry?.refresh("online-if-uncached");
			},
		});
		await host.start(socketPath);
		console.log(SHARED_ENGINE_READY_PATTERN);
		if (interrupted) host.retire();
		await host.closed;
		engineStopped = true;
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		if (supervisor && !engineStopped) {
			const result = await supervisor.close({ consumerClosed: true, preserveOnDrainConflict: true });
			if (result.kind !== "stopped")
				logger.error("Shared engine startup cleanup failed", {
					state: result.state.name,
					reason: result.state.reason,
				});
		}
		gateway?.close();
		authStorage?.close();
	}
	process.exit(0);
}
