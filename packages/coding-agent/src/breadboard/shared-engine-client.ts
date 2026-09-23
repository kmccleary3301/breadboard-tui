import { realpathSync } from "node:fs";
import * as path from "node:path";
import type { ObservedGatewayEffort } from "@oh-my-pi/pi-ai/auth-gateway";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";
import { createDaemonBrokerClient, DaemonBrokerRejectedError, type DaemonBrokerClient } from "../launch/client";
import { daemonRuntimeDir } from "../launch/paths";
import type { DaemonSpec } from "@oh-my-pi/pi-tui/tools/hub";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../subprocess/worker-client";
import { LocalAuthorityStore } from "./lifecycle/local-authority-store";
import {
	engineStateNamespaceKey,
	resolveBreadboardRunConfig,
	type BreadboardRunConfig,
	type SelectedBreadboardConfig,
} from "./lifecycle/run-config";
import {
	SHARED_ENGINE_CONFIG_ENV,
	SHARED_ENGINE_READY_PATTERN,
	SHARED_ENGINE_SCHEMA_VERSION,
	SHARED_ENGINE_SOCKET_ENV,
	SHARED_ENGINE_WORKER_ARG,
	parseSharedEngineEvent,
	parseSharedEngineInfo,
	parseSharedEngineLaunch,
	sharedEngineKey,
	type SharedEngineInfo,
	type SharedEngineLaunch,
} from "./shared-engine-protocol";

const REQUEST_TIMEOUT_MS = 10_000;
const START_RETRY_MS = 100;
const MAX_EFFORT_OBSERVATIONS = 256;
const SHARED_ENGINE_DAEMON_PREFIX = "omp.shared.bb.v2.";
const effortSources = new Set<Map<string, ObservedGatewayEffort>>();

export interface AcquiredSharedBreadboardEngine {
	readonly config: BreadboardRunConfig;
	readonly info: SharedEngineInfo;
	refreshAuth(): Promise<void>;
	close(): Promise<void>;
}

async function sharedLaunch(
	config: BreadboardRunConfig,
	workspacePath: string,
	ompAgentDir?: string,
	retainedSessionId?: string,
): Promise<SharedEngineLaunch> {
	const agentDir = realpathSync(getAgentDir());
	const canonicalWorkspace = realpathSync(workspacePath);
	const canonicalOmpAgentDir = ompAgentDir === undefined ? undefined : realpathSync(ompAgentDir);
	const store = new LocalAuthorityStore(path.join(agentDir, "breadboard", "lifecycle"));
	let stateNamespaceKey: string;
	try {
		stateNamespaceKey = await store.resolveEngineStateNamespace(
			engineStateNamespaceKey(config, canonicalOmpAgentDir),
			canonicalWorkspace,
			retainedSessionId,
		);
	} finally {
		await store.close();
	}
	const selectedConfig: SelectedBreadboardConfig = {
		engineMode: config.mode,
		...(config.sources.endpoint === "derived-default" ? {} : { baseUrl: config.endpoint }),
		engineArtifact: config.engineArtifact,
		workspaceId: config.workspaceId,
		startupTimeoutMs: config.startupTimeoutMs,
		requestTimeoutMs: config.requestTimeoutMs,
		ownerExitPolicy: config.ownerExitPolicy,
		...(config.sessionConfigPath === undefined ? {} : { sessionConfigPath: config.sessionConfigPath }),
	};
	return parseSharedEngineLaunch({
		schemaVersion: SHARED_ENGINE_SCHEMA_VERSION,
		workspacePath: canonicalWorkspace,
		agentDir,
		...(canonicalOmpAgentDir === undefined ? {} : { ompAgentDir: canonicalOmpAgentDir }),
		selectedConfig,
		derivedEndpoint: config.sources.endpoint === "derived-default",
		stateNamespaceKey,
	});
}

function fetchUnix(socket: string, input: string, init?: BunFetchRequestInit): Promise<Response> {
	return fetch(`http://shared-engine.local${input}`, {
		...init,
		unix: socket,
		signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
}

async function readInfo(socket: string): Promise<SharedEngineInfo | undefined> {
	let response: Response;
	try {
		response = await fetchUnix(socket, "/info");
	} catch {
		return undefined;
	}
	if (response.status === 503) {
		await response.text();
		return undefined;
	}
	if (!response.ok) throw new Error(`Shared engine discovery failed with HTTP ${response.status}`);
	return parseSharedEngineInfo(await response.json());
}

async function reuseCompatibleNamespace(
	broker: DaemonBrokerClient,
	launch: SharedEngineLaunch,
): Promise<SharedEngineLaunch> {
	const listed = await broker.request({ op: "list" });
	if (listed.op !== "list") throw new Error("Shared engine broker returned an unexpected list response");
	for (const daemon of listed.daemons) {
		if (daemon.state !== "ready" || !daemon.name.startsWith(SHARED_ENGINE_DAEMON_PREFIX)) continue;
		const described = await broker.request({ op: "describe", name: daemon.name });
		if (described.op !== "describe") throw new Error("Shared engine broker returned an unexpected description");
		const launchJson = described.spec.env[SHARED_ENGINE_CONFIG_ENV];
		if (launchJson === undefined) throw new Error("Shared engine worker launch configuration is missing");
		const candidate = parseSharedEngineLaunch(JSON.parse(launchJson));
		const selected = { ...launch, stateNamespaceKey: candidate.stateNamespaceKey };
		const key = sharedEngineKey(selected);
		if (key !== sharedEngineKey(candidate)) continue;
		const keyScope = key.slice(0, 24);
		if (daemon.name !== `${SHARED_ENGINE_DAEMON_PREFIX}${keyScope}`)
			throw new Error("Shared engine worker name conflicts with its launch configuration");
		const socket = path.join(daemonRuntimeDir(broker.projectDir), `shared-engine-${keyScope}.sock`);
		const info = await readInfo(socket);
		if (info === undefined) continue;
		if (info.key !== key) throw new Error("Shared engine identity conflicts with its launch configuration");
		return Object.freeze(selected);
	}
	return launch;
}

function startSpec(launch: SharedEngineLaunch, socket: string, daemonName: string, timeoutMs: number): DaemonSpec {
	const spawn = resolveWorkerSpawnCmd(SHARED_ENGINE_WORKER_ARG);
	const application = spawn.cmd[0];
	if (application === undefined) throw new Error("Shared engine worker executable is missing");
	const env = workerEnvFromParent({
		[SHARED_ENGINE_SOCKET_ENV]: socket,
		[SHARED_ENGINE_CONFIG_ENV]: JSON.stringify(launch),
		PI_CODING_AGENT_DIR: launch.agentDir,
	});
	delete env.OMP_PROFILE;
	delete env.PI_PROFILE;
	delete env.BREADBOARD_OMP_AGENT_DIR;
	if (launch.ompAgentDir !== undefined) env.BREADBOARD_OMP_AGENT_DIR = launch.ompAgentDir;
	return {
		name: daemonName,
		application,
		args: spawn.cmd.slice(1),
		env,
		cwd: spawn.cwd ?? launch.workspacePath,
		pty: false,
		ready: { log: SHARED_ENGINE_READY_PATTERN, timeoutMs },
		restart: "no",
		// Broker group termination must never bypass authenticated engine shutdown.
		persist: true,
		detached: true,
	};
}

async function startOrReuse(
	broker: DaemonBrokerClient,
	launch: SharedEngineLaunch,
	socket: string,
	daemonName: string,
	deadline: number,
): Promise<SharedEngineInfo> {
	const key = sharedEngineKey(launch);
	while (Date.now() < deadline) {
		const info = await readInfo(socket);
		if (info !== undefined) {
			if (info.key !== key)
				throw new Error("Shared engine identity conflicts with this workspace/profile/configuration");
			return info;
		}
		const listed = await broker.request({ op: "list" });
		if (listed.op !== "list") throw new Error("Shared engine broker returned an unexpected list response");
		const existing = listed.daemons.find(daemon => daemon.name === daemonName);
		if (!existing || existing.state === "exited" || existing.state === "failed") {
			try {
				const started = await broker.request({
					op: "start",
					spec: startSpec(launch, socket, daemonName, Math.max(1, deadline - Date.now())),
				});
				if (started.op !== "start") throw new Error("Shared engine broker returned an unexpected start response");
				if (started.daemon.state === "failed" || started.daemon.state === "exited") {
					throw new Error(
						`Shared engine worker ${daemonName} exited: ${started.daemon.exitReason ?? started.daemon.exitCode ?? "unknown reason"}`,
					);
				}
			} catch (error) {
				// Only another authenticated broker start can win this race. Never stop it.
				if (!(error instanceof DaemonBrokerRejectedError) || !error.message.includes(" is already ")) throw error;
			}
		}
		await Bun.sleep(START_RETRY_MS);
	}
	throw new Error(`Shared engine ${daemonName} did not become available before startup timeout`);
}

function sameEngine(actual: SharedEngineInfo, expected: SharedEngineInfo): boolean {
	return (
		actual.key === expected.key &&
		actual.endpoint === expected.endpoint &&
		actual.engineInstanceId === expected.engineInstanceId &&
		actual.engineBootId === expected.engineBootId &&
		actual.pid === expected.pid &&
		actual.osProcessStartToken === expected.osProcessStartToken
	);
}

async function consumeLease(
	response: Response,
	signal: AbortSignal,
	info: SharedEngineInfo,
	ready: () => void,
	efforts: Map<string, ObservedGatewayEffort>,
): Promise<void> {
	if (!response.body) throw new Error("Shared engine lease response had no body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let admitted = false;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) {
				if (!signal.aborted) throw new Error("Shared engine lease disconnected");
				return;
			}
			buffer += decoder.decode(next.value, { stream: true });
			if (buffer.length > 1_048_576) throw new Error("Shared engine lease event exceeded its size limit");
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				const event = parseSharedEngineEvent(JSON.parse(line));
				if (event.kind === "ready") {
					if (admitted || !sameEngine(event.info, info)) throw new Error("Shared engine lease identity changed");
					admitted = true;
					ready();
				} else {
					if (!admitted) throw new Error("Shared engine sent metadata before admitting this client");
					efforts.delete(event.sessionKey);
					efforts.set(event.sessionKey, event.effort);
					if (efforts.size > MAX_EFFORT_OBSERVATIONS) {
						const oldest = efforts.keys().next();
						if (!oldest.done) efforts.delete(oldest.value);
					}
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}

export async function acquireSharedBreadboardEngine(
	config: BreadboardRunConfig,
	workspacePath: string,
	ompAgentDir?: string,
	retainedSessionId?: string,
): Promise<AcquiredSharedBreadboardEngine> {
	let launch = await sharedLaunch(config, workspacePath, ompAgentDir, retainedSessionId);
	const broker = await createDaemonBrokerClient(launch.workspacePath);
	const deadline = Date.now() + config.startupTimeoutMs + REQUEST_TIMEOUT_MS;
	let leaseAbort: AbortController | undefined;
	let leaseTask: Promise<void> | undefined;
	let leaseFailure: unknown;
	let closePromise: Promise<void> | undefined;
	const efforts = new Map<string, ObservedGatewayEffort>();
	const close = (): Promise<void> => {
		closePromise ??= (async () => {
			leaseAbort?.abort();
			await leaseTask;
			effortSources.delete(efforts);
			efforts.clear();
			broker.close();
			if (leaseFailure !== undefined) throw leaseFailure;
		})();
		return closePromise;
	};
	try {
		await broker.request({ op: "ping" });
		if (retainedSessionId === undefined) launch = await reuseCompatibleNamespace(broker, launch);
		const keyScope = sharedEngineKey(launch).slice(0, 24);
		const socket = path.join(daemonRuntimeDir(broker.projectDir), `shared-engine-${keyScope}.sock`);
		const daemonName = `${SHARED_ENGINE_DAEMON_PREFIX}${keyScope}`;
		for (;;) {
			const info = await startOrReuse(broker, launch, socket, daemonName, deadline);
			leaseAbort = new AbortController();
			const admissionTimer = setTimeout(() => leaseAbort?.abort(), Math.max(1, deadline - Date.now()));
			let response: Response;
			try {
				// As with engine event streams, only the client's AbortSignal owns this lifetime.
				response = await fetchUnix(socket, "/lease", { signal: leaseAbort.signal, timeout: false });
			} catch (error) {
				clearTimeout(admissionTimer);
				throw error;
			}
			if (response.status === 503) {
				clearTimeout(admissionTimer);
				await response.text();
				leaseAbort.abort();
				await Bun.sleep(START_RETRY_MS);
				continue;
			}
			if (!response.ok) {
				clearTimeout(admissionTimer);
				await response.text();
				throw new Error(`Shared engine lease failed with HTTP ${response.status}`);
			}
			const ready = Promise.withResolvers<void>();
			const signal = leaseAbort.signal;
			leaseTask = consumeLease(response, signal, info, ready.resolve, efforts).catch(error => {
				ready.reject(error);
				if (!signal.aborted) {
					leaseFailure = error;
					effortSources.delete(efforts);
					logger.error("BreadBoard shared engine connection lost", { error: String(error) });
				}
			});
			try {
				await ready.promise;
			} finally {
				clearTimeout(admissionTimer);
			}
			effortSources.add(efforts);
			const acquiredConfig = resolveBreadboardRunConfig({
				selectedConfig: {
					engineMode: "local-external",
					baseUrl: info.endpoint,
					workspaceId: config.workspaceId,
					startupTimeoutMs: config.startupTimeoutMs,
					requestTimeoutMs: config.requestTimeoutMs,
					...(config.sessionConfigPath === undefined ? {} : { sessionConfigPath: config.sessionConfigPath }),
				},
				workspacePath: launch.workspacePath,
				environment: { BREADBOARD_PRODUCT: "1" },
			});
			return {
				config: acquiredConfig,
				info,
				async refreshAuth() {
					if (leaseFailure !== undefined) throw leaseFailure;
					// Cold credential/model discovery belongs to startup, not the short local-RPC budget.
					const refreshed = await fetchUnix(socket, "/refresh", {
						method: "POST",
						signal: AbortSignal.timeout(config.startupTimeoutMs),
					});
					if (!refreshed.ok) throw new Error(`Shared engine auth refresh failed with HTTP ${refreshed.status}`);
					await refreshed.text();
				},
				close,
			};
		}
	} catch (error) {
		try {
			await close();
		} catch (cleanupError) {
			if (cleanupError !== error)
				throw new AggregateError([error, cleanupError], "Shared engine acquisition and release failed");
		}
		throw error;
	}
}

export function readSharedEngineEffort(sessionKey: string): ObservedGatewayEffort | undefined {
	let observed: ObservedGatewayEffort | undefined;
	for (const source of effortSources) {
		const effort = source.get(sessionKey);
		if (effort !== undefined) observed = effort;
	}
	return observed;
}
