import { ApiError, type BreadboardClient, type SessionSummary } from "@breadboard/sdk/engine";
import type { PublicResult } from "@breadboard/sdk";
import { logger } from "@oh-my-pi/pi-utils";
import type { HarnessPort, HarnessProvenance, HarnessRefreshReason, HarnessSnapshot } from "./harness-port";

type PublicData = Readonly<Record<string, unknown>>;

type HarnessDefinition = Readonly<Record<string, unknown>>;

export interface ResolvedHarness {
	readonly id: string;
	readonly name: string;
}

type HarnessChoice = {
	readonly id: string;
	readonly name: string;
	readonly path: string;
};

export class HarnessResolutionError extends Error {
	readonly code = "harness_unavailable";

	constructor(
		readonly requested: string,
		readonly operation: string,
		readonly status: number | undefined,
		readonly sdkCode: string | undefined,
		message: string,
		cause?: unknown,
	) {
		super(`BreadBoard harness unavailable: ${message}`, { cause });
		this.name = "HarnessResolutionError";
	}
}

export interface CreateHarnessPortOptions {
	readonly client: BreadboardClient;
	readonly sessionId: string | (() => string);
	/** Harness source path/id accepted by the public harness operations. */
	readonly harnessId: string;
	/** Engine-port model control, preserving lifecycle checks around set_model. */
	readonly setSessionModel?: (model: string) => Promise<void>;
	readonly now?: () => number;
}

export type { HarnessChoice };

function isRecord(value: unknown): value is PublicData {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`BreadBoard harness response missing ${label}`);
	return value;
}

function nullableString(value: unknown, label: string): string | null {
	if (value === undefined || value === null) return null;
	return requiredString(value, label);
}

function publicData(result: PublicResult, operation: string): PublicData {
	if (result.schema_version !== "bb.cli.result.v1" || !result.ok || result.status !== "ok") {
		const detail = result.error?.message ?? `exit code ${result.exit_code}`;
		throw new Error(`BreadBoard ${operation} failed: ${detail}`);
	}
	return result.data;
}

/**
 * Require a successful public harness operation and return its payload.
 *
 * The SDK deliberately returns validation and lock failures as typed result
 * envelopes, so callers must check the envelope before reading `data`.
 */
export function requireHarnessResultData(result: PublicResult, operation: string): PublicData {
	return publicData(result, operation);
}

function dataRecord(result: PublicResult, operation: string, key: string): PublicData {
	const value = publicData(result, operation)[key];
	if (!isRecord(value)) throw new Error(`BreadBoard ${operation} response missing ${key}`);
	return value;
}

function lockPathForHarness(harnessId: string): string {
	if (harnessId.endsWith(".lock.json")) return harnessId;
	if (harnessId.endsWith(".yaml")) return `${harnessId.slice(0, -5)}.lock.json`;
	if (harnessId.endsWith(".yml")) return `${harnessId.slice(0, -4)}.lock.json`;
	return `${harnessId}.lock.json`;
}

function harnessName(definition: HarnessDefinition, harnessId: string): string {
	const profile = definition.profile;
	if (isRecord(profile) && typeof profile.name === "string" && profile.name.trim()) return profile.name;
	const last = harnessId.split(/[\\/]/u).at(-1) ?? harnessId;
	return last.replace(/\.(?:yaml|yml)$/u, "");
}

function parseProvenance(explanation: PublicData, lock: PublicData): Readonly<Record<string, HarnessProvenance>> {
	const fields = explanation.fields;
	if (!Array.isArray(fields)) throw new Error("BreadBoard harness.explain response missing fields");
	const sourceLayers = Array.isArray(lock.source_layers) ? lock.source_layers : [];
	const layerSources = new Map<string, string>();
	for (const sourceLayer of sourceLayers) {
		if (!isRecord(sourceLayer)) continue;
		if (typeof sourceLayer.layer_id !== "string") continue;
		const sourceRef = sourceLayer.source_ref;
		if (typeof sourceRef === "string" && sourceRef.length > 0) layerSources.set(sourceLayer.layer_id, sourceRef);
	}
	const provenance: Record<string, HarnessProvenance> = {};
	for (const field of fields) {
		if (!isRecord(field)) throw new Error("BreadBoard harness.explain response contains an invalid field");
		const path = requiredString(field.path, "explanation field path");
		const layer = requiredString(field.source_layer, `source layer for ${path}`);
		provenance[path] = {
			source: layerSources.get(layer) ?? layer,
			line: typeof field.line === "number" && Number.isSafeInteger(field.line) ? field.line : null,
		};
	}
	return provenance;
}

function parseHarnessId(harness: PublicData, fallback: string): string {
	return typeof harness.path === "string" && harness.path.length > 0 ? harness.path : fallback;
}

function parseSnapshot(
	harnessResult: PublicResult,
	explainResult: PublicResult,
	lockResult: PublicResult,
	session: SessionSummary,
	harnessFallback: string,
	now: () => number,
): HarnessSnapshot {
	const harnessData = dataRecord(harnessResult, "harness.get", "definition");
	const explainData = publicData(explainResult, "harness.explain");
	const lockData = dataRecord(lockResult, "harness_lock.get", "lock");
	const harnessId = parseHarnessId(harnessData, harnessFallback);
	const lockHash = nullableString(session.effective_lock_hash, "session effective_lock_hash");
	const lockGraphHash = nullableString(lockData.graph_hash, "harness lock graph_hash");
	const verifiedIdentity = lockHash !== null && lockGraphHash === lockHash ? { harnessId, lockHash } : null;
	const generation = nullableString(session.generation_id, "session generation_id");
	return Object.freeze({
		harnessId,
		name: harnessName(harnessData, harnessId),
		lockHash,
		verifiedIdentity,
		generation,
		mode: nullableString(session.mode, "session mode"),
		lock: verifiedIdentity === null ? null : lockData,
		provenance: verifiedIdentity === null ? {} : parseProvenance(explainData, lockData),
		loadedAt: now(),
	});
}

function snapshotIdentity(snapshot: HarnessSnapshot | null): string {
	if (snapshot === null) return "null";
	return JSON.stringify({
		harnessId: snapshot.harnessId,
		name: snapshot.name,
		lockHash: snapshot.lockHash,
		verifiedIdentity: snapshot.verifiedIdentity,
		generation: snapshot.generation,
		mode: snapshot.mode,
		lock: snapshot.lock,
		provenance: snapshot.provenance,
	});
}

export function createHarnessPort(options: CreateHarnessPortOptions): HarnessPort {
	let current: HarnessSnapshot | null = null;
	let requestedHarnessId = options.harnessId;
	const listeners = new Set<(snapshot: HarnessSnapshot | null) => void>();
	const now = options.now ?? Date.now;
	const refresh = async (_reason: HarnessRefreshReason): Promise<HarnessSnapshot | null> => {
		const sessionId = typeof options.sessionId === "function" ? options.sessionId() : options.sessionId;
		const { id: harnessId, result: harness } = await resolveHarnessResult(options.client, requestedHarnessId);
		const [explanation, lock, session] = await Promise.all([
			options.client.explainHarness(harnessId),
			options.client.getHarnessLock(lockPathForHarness(harnessId)),
			options.client.getSession(sessionId),
		]);
		const next = parseSnapshot(harness, explanation, lock, session, harnessId, now);
		if (snapshotIdentity(next) !== snapshotIdentity(current)) {
			current = next;
			for (const listener of listeners) listener(next);
		}
		return current;
	};
	return {
		controlClient: options.client,
		current: () => current,
		refresh,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		setHarnessId(harnessId) {
			requestedHarnessId = harnessId;
		},
		setSessionMode: async mode => {
			const sessionId = typeof options.sessionId === "function" ? options.sessionId() : options.sessionId;
			const response = await options.client.postCommand(sessionId, { command: "set_mode", payload: { mode } });
			if (response.detail?.status !== "ok" || response.detail.mode !== mode) {
				throw new Error("BreadBoard engine returned an invalid mode-selection receipt");
			}
		},
		setSessionRole: async (role, model) => {
			const sessionId = typeof options.sessionId === "function" ? options.sessionId() : options.sessionId;
			const response = await options.client.postCommand(sessionId, {
				command: "set_role",
				payload: model === undefined ? { role } : { role, model },
			});
			if (response.detail?.status !== "ok" || response.detail.role !== role) {
				throw new Error("BreadBoard engine returned an invalid role-selection receipt");
			}
		},
		setSessionSkills: async skills => {
			const sessionId = typeof options.sessionId === "function" ? options.sessionId() : options.sessionId;
			const response = await options.client.postCommand(sessionId, {
				command: "set_skills",
				payload: { selected: [...skills] },
			});
			if (response.detail?.status !== "ok") {
				throw new Error("BreadBoard engine returned an invalid skills-selection receipt");
			}
		},
		setSessionModel: options.setSessionModel,
		listHarnessChoices: () => listHarnessChoices(options.client),
	};
}

async function resolveHarnessResult(
	client: BreadboardClient,
	requested: string,
): Promise<{ readonly id: string; readonly result: PublicResult }> {
	const candidates =
		requested.includes("/") || /\.(?:yaml|yml|json)$/u.test(requested)
			? [requested]
			: [`agent_configs/v2/${requested}.yaml`, `agent_configs/${requested}.yaml`, `${requested}.yaml`, requested];
	let lastError: unknown;
	for (const candidate of candidates) {
		try {
			return { id: candidate, result: await client.getHarness(candidate) };
		} catch (error) {
			lastError = error;
			if (!(error instanceof ApiError) || error.status !== 404) throw error;
		}
	}
	if (requested === "daily_driver") {
		try {
			const initialized = publicData(await client.createHarness("."), "harness.init");
			const initializedPath = requiredString(initialized.path, "initialized harness path");
			return { id: initializedPath, result: await client.getHarness(initializedPath) };
		} catch (error) {
			lastError = error;
		}
	}
	const apiError = lastError instanceof ApiError ? lastError : undefined;
	const body = apiError?.body;
	const errorBody =
		typeof body === "object" && body !== null && !Array.isArray(body) && "error" in body ? body.error : undefined;
	const sdkCode =
		typeof errorBody === "object" && errorBody !== null && !Array.isArray(errorBody) && "error_code" in errorBody
			? typeof errorBody.error_code === "string"
				? errorBody.error_code
				: undefined
			: undefined;
	const message =
		typeof errorBody === "object" && errorBody !== null && !Array.isArray(errorBody) && "message" in errorBody
			? typeof errorBody.message === "string"
				? errorBody.message
				: (apiError?.message ?? String(lastError))
			: (apiError?.message ?? String(lastError));
	const wrapped = new HarnessResolutionError(requested, "harness.get", apiError?.status, sdkCode, message, lastError);
	logger.error("BreadBoard harness resolution failed", {
		requested,
		operation: wrapped.operation,
		status: wrapped.status ?? null,
		sdkCode: wrapped.sdkCode ?? null,
		error: wrapped.message,
	});
	throw wrapped;
}

function choiceFromPath(path: string): HarnessChoice {
	const name =
		path
			.split(/[\\/]/u)
			.at(-1)
			?.replace(/\.(?:yaml|yml)$/u, "") ?? path;
	return { id: path, name, path };
}

/** Resolve a CLI or palette harness reference to the engine id and display name. */
export async function resolveHarness(client: BreadboardClient, requested: string): Promise<ResolvedHarness> {
	const { id: resolvedId, result } = await resolveHarnessResult(client, requested);
	const data = publicData(result, "harness.get");
	const harness = isRecord(data.harness) ? data.harness : data;
	const id = typeof harness.path === "string" && harness.path.trim() ? harness.path : resolvedId;
	const definition =
		(isRecord(data.definition) && data.definition) || (isRecord(harness.definition) && harness.definition) || harness;
	return { id, name: harnessName(definition, requested) };
}

/** Resolve a CLI or palette harness name to the engine's source path. */
export async function resolveHarnessId(client: BreadboardClient, requested: string): Promise<string> {
	return (await resolveHarness(client, requested)).id;
}

export async function listHarnessChoices(client: BreadboardClient): Promise<readonly HarnessChoice[]> {
	try {
		const result = await client.listHarness();
		const data = publicData(result, "harness.list");
		if (!Array.isArray(data.harnesses)) throw new Error("BreadBoard harness.list response missing harnesses");
		return data.harnesses.map(value => choiceFromPath(requiredString(value, "harness path")));
	} catch (error) {
		logger.warn("BreadBoard harness choices unavailable", { error: String(error) });
		throw error;
	}
}
