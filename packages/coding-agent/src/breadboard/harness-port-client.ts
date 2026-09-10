import type { BreadboardClient, SessionSummary } from "@breadboard/sdk/engine";
import type { PublicResult } from "@breadboard/sdk";
import { logger } from "@oh-my-pi/pi-utils";
import type { HarnessPort, HarnessProvenance, HarnessRefreshReason, HarnessSnapshot } from "./harness-port";

type PublicData = Readonly<Record<string, unknown>>;

type HarnessDefinition = Readonly<Record<string, unknown>>;

type HarnessChoice = {
	readonly id: string;
	readonly name: string;
	readonly path: string;
};

export interface CreateHarnessPortOptions {
	readonly client: BreadboardClient;
	readonly sessionId: string | (() => string);
	/** Harness source path/id accepted by the public harness operations. */
	readonly harnessId: string;
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
	const generation = nullableString(session.generation_id, "session generation_id");
	return Object.freeze({
		harnessId,
		name: harnessName(harnessData, harnessId),
		lockHash,
		generation,
		mode: nullableString(session.mode, "session mode"),
		lock: lockData,
		provenance: parseProvenance(explainData, lockData),
		loadedAt: now(),
	});
}

function snapshotIdentity(snapshot: HarnessSnapshot | null): string {
	if (snapshot === null) return "null";
	return JSON.stringify({
		harnessId: snapshot.harnessId,
		name: snapshot.name,
		lockHash: snapshot.lockHash,
		generation: snapshot.generation,
		mode: snapshot.mode,
		lock: snapshot.lock,
		provenance: snapshot.provenance,
	});
}

export function createHarnessPort(options: CreateHarnessPortOptions): HarnessPort {
	let current: HarnessSnapshot | null = null;
	const listeners = new Set<(snapshot: HarnessSnapshot | null) => void>();
	const now = options.now ?? Date.now;
	const refresh = async (_reason: HarnessRefreshReason): Promise<HarnessSnapshot | null> => {
		const sessionId = typeof options.sessionId === "function" ? options.sessionId() : options.sessionId;
		const [harness, explanation, lock, session] = await Promise.all([
			options.client.getHarness(options.harnessId),
			options.client.explainHarness(options.harnessId),
			options.client.getHarnessLock(lockPathForHarness(options.harnessId)),
			options.client.getSession(sessionId),
		]);
		const next = parseSnapshot(harness, explanation, lock, session, options.harnessId, now);
		if (snapshotIdentity(next) !== snapshotIdentity(current)) {
			current = next;
			for (const listener of listeners) listener(next);
		}
		return current;
	};
	return {
		current: () => current,
		refresh,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

function choiceFromPath(path: string): HarnessChoice {
	const name =
		path
			.split(/[\\/]/u)
			.at(-1)
			?.replace(/\.(?:yaml|yml)$/u, "") ?? path;
	return { id: path, name, path };
}

/** Resolve a CLI or palette harness name to the engine's source path. */
export async function resolveHarnessId(client: BreadboardClient, requested: string): Promise<string> {
	const data = publicData(await client.getHarness(requested), "harness.get");
	const harness = isRecord(data.harness) ? data.harness : data;
	return typeof harness.path === "string" && harness.path.trim() ? harness.path : requested;
}

export async function listHarnessChoices(
	client: BreadboardClient,
	_directory?: string,
): Promise<readonly HarnessChoice[]> {
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
