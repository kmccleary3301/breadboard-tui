import { createHash } from "node:crypto";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import {
	parseSelectedBreadboardConfig,
	isLoopbackEndpoint,
	resolveBreadboardRunConfig,
	type SelectedBreadboardConfig,
} from "./lifecycle/run-config";

export { SHARED_ENGINE_WORKER_ARG } from "../cli/worker-selectors";

export const SHARED_ENGINE_CONFIG_ENV = "BREADBOARD_SHARED_ENGINE_CONFIG";
export const SHARED_ENGINE_SOCKET_ENV = "BREADBOARD_SHARED_ENGINE_SOCKET";
export const SHARED_ENGINE_READY_PATTERN = String.raw`breadboard shared engine serving`;
// v3: leases carry only the admission event. The version feeds the engine key, so a v2 worker
// (which also streams effort events) gets a different socket and daemon name and is never reused.
export const SHARED_ENGINE_SCHEMA_VERSION = "bb.shared-engine.v3" as const;

export interface SharedEngineLaunch {
	readonly schemaVersion: typeof SHARED_ENGINE_SCHEMA_VERSION;
	readonly workspacePath: string;
	readonly agentDir: string;
	readonly ompAgentDir?: string;
	readonly selectedConfig: SelectedBreadboardConfig;
	readonly derivedEndpoint: boolean;
	readonly stateNamespaceKey: string;
}

export interface SharedEngineInfo {
	readonly schemaVersion: typeof SHARED_ENGINE_SCHEMA_VERSION;
	readonly key: string;
	readonly endpoint: string;
	readonly engineInstanceId: string;
	readonly engineBootId: string;
	readonly pid: number;
	readonly osProcessStartToken: string;
}

export type SharedEngineEvent = { readonly kind: "ready"; readonly info: SharedEngineInfo };

function requiredString(record: Record<string, unknown>, field: string): string {
	const value = record[field];
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
		throw new Error(`shared engine ${field} must be a non-empty string`);
	}
	return value;
}

function absoluteDirectory(record: Record<string, unknown>, field: string): string {
	const value = requiredString(record, field);
	if (!path.isAbsolute(value)) throw new Error(`shared engine ${field} must be absolute`);
	return value;
}

export function parseSharedEngineLaunch(value: unknown): SharedEngineLaunch {
	if (!isRecord(value)) throw new Error("shared engine launch must be an object");
	if (value.schemaVersion !== SHARED_ENGINE_SCHEMA_VERSION) throw new Error("unsupported shared engine launch schema");
	const selectedConfig = parseSelectedBreadboardConfig(value.selectedConfig);
	if (typeof value.derivedEndpoint !== "boolean") throw new Error("shared engine derivedEndpoint must be boolean");
	const ompAgentDir = value.ompAgentDir === undefined ? undefined : absoluteDirectory(value, "ompAgentDir");
	const stateNamespaceKey = requiredString(value, "stateNamespaceKey");
	if (!/^[a-f0-9]{64}$/.test(stateNamespaceKey)) throw new Error("shared engine state namespace key is invalid");
	const launch: SharedEngineLaunch = {
		schemaVersion: SHARED_ENGINE_SCHEMA_VERSION,
		workspacePath: absoluteDirectory(value, "workspacePath"),
		agentDir: absoluteDirectory(value, "agentDir"),
		...(ompAgentDir === undefined ? {} : { ompAgentDir }),
		selectedConfig,
		derivedEndpoint: value.derivedEndpoint,
		stateNamespaceKey,
	};
	const config = resolveBreadboardRunConfig({
		selectedConfig,
		workspacePath: launch.workspacePath,
		environment: { BREADBOARD_PRODUCT: "1" },
	});
	if (config.mode !== "local-owned" || config.ownerExitPolicy !== "attached") {
		throw new Error("shared engine launch requires attached local-owned mode");
	}
	return Object.freeze(launch);
}

export function sharedEngineKey(launch: SharedEngineLaunch): string {
	const selected = launch.selectedConfig;
	return createHash("sha256")
		.update(
			JSON.stringify({
				schemaVersion: SHARED_ENGINE_SCHEMA_VERSION,
				workspacePath: launch.workspacePath,
				agentDir: launch.agentDir,
				ompAgentDir: launch.ompAgentDir,
				selectedConfig: selected,
				derivedEndpoint: launch.derivedEndpoint,
				stateNamespaceKey: launch.stateNamespaceKey,
			}),
		)
		.digest("hex");
}

export function parseSharedEngineInfo(value: unknown): SharedEngineInfo {
	if (!isRecord(value)) throw new Error("shared engine info must be an object");
	if (value.schemaVersion !== SHARED_ENGINE_SCHEMA_VERSION) throw new Error("unsupported shared engine info schema");
	const key = requiredString(value, "key");
	if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("shared engine identity key is invalid");
	const endpoint = requiredString(value, "endpoint");
	const url = new URL(endpoint);
	if (
		url.protocol !== "http:" ||
		!isLoopbackEndpoint(endpoint) ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	) {
		throw new Error("shared engine endpoint must be an unauthenticated loopback HTTP origin");
	}
	const pid = value.pid;
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0)
		throw new Error("shared engine pid is invalid");
	return Object.freeze({
		schemaVersion: SHARED_ENGINE_SCHEMA_VERSION,
		key,
		endpoint,
		engineInstanceId: requiredString(value, "engineInstanceId"),
		engineBootId: requiredString(value, "engineBootId"),
		pid,
		osProcessStartToken: requiredString(value, "osProcessStartToken"),
	});
}

export function parseSharedEngineEvent(value: unknown): SharedEngineEvent {
	if (!isRecord(value)) throw new Error("shared engine event must be an object");
	if (value.kind === "ready") return { kind: "ready", info: parseSharedEngineInfo(value.info) };
	throw new Error("unknown shared engine event kind");
}
