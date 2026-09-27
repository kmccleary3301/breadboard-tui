import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
const E4_PROJECTION_RECEIPT_PREFIX = "breadboard:e4:";

function breadboardProjectionEventId(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	if ("responseId" in message && typeof message.responseId === "string") {
		if (message.responseId.startsWith(E4_PROJECTION_RECEIPT_PREFIX)) {
			return message.responseId.slice(E4_PROJECTION_RECEIPT_PREFIX.length) || undefined;
		}
	}
	if (!("details" in message) || !message.details || typeof message.details !== "object") return undefined;
	if (!("breadboardProjectionEventId" in message.details)) return undefined;
	const eventId = message.details.breadboardProjectionEventId;
	return typeof eventId === "string" && eventId ? eventId : undefined;
}
import { lockValue } from "./harness-lock-view";
import type { HarnessSnapshot } from "./harness-port";
function isBreadboardProviderFreeModel(model: { provider: string }): boolean {
	return ["mock", "cli_mock", "smoke", "replay"].includes(model.provider);
}

export interface BreadboardComposerSpend {
	readonly sessionUsd: number | null;
	readonly turnUsd: number | null;
	readonly estimated: boolean;
}

export interface BreadboardComposerMetrics {
	readonly effort?: ThinkingLevel | null;
	readonly spend?: BreadboardComposerSpend | null;
}

interface TranscriptMetrics {
	readonly revision: number;
	readonly leafId: ReturnType<AgentSession["sessionManager"]["getLeafId"]>;
	readonly model: AgentSession["model"];
	readonly spend: BreadboardComposerSpend | null;
}
const transcriptMetrics = new WeakMap<AgentSession, TranscriptMetrics>();

function effortValue(value: unknown): ThinkingLevel | undefined {
	switch (value) {
		case "off":
			return ThinkingLevel.Off;
		case "minimal":
			return ThinkingLevel.Minimal;
		case "low":
			return ThinkingLevel.Low;
		case "medium":
			return ThinkingLevel.Medium;
		case "high":
			return ThinkingLevel.High;
		case "xhigh":
			return ThinkingLevel.XHigh;
		case "max":
			return ThinkingLevel.Max;
		default:
			return undefined;
	}
}

/** The effort the verified harness lock configures for the session's model. */
function readHarnessEffort(session: AgentSession, harness: HarnessSnapshot | null): ThinkingLevel | undefined {
	if (
		!harness?.lock ||
		!harness.verifiedIdentity ||
		harness.verifiedIdentity.lockHash !== harness.lockHash ||
		harness.verifiedIdentity.harnessId !== harness.harnessId
	)
		return undefined;
	const defaultModel = lockValue(harness.lock, "providers.default_model")?.value;
	const models = lockValue(harness.lock, "providers.models")?.value;
	if (
		typeof defaultModel !== "string" ||
		!Array.isArray(models) ||
		!session.model ||
		(defaultModel !== session.model.id && defaultModel !== `${session.model.provider}/${session.model.id}`)
	)
		return undefined;
	for (const model of models) {
		if (!isRecord(model) || model.id !== defaultModel) continue;
		return isRecord(model.params) ? effortValue(model.params.reasoning_effort) : undefined;
	}
	return undefined;
}

function finiteNonNegative(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}

function messageSpend(session: AgentSession, message: AssistantMessage): number | null {
	const active = session.model;
	const model =
		active?.provider === message.provider && active.id === message.model
			? active
			: session.modelRegistry.find(message.provider, message.model);
	if (!model || model.provider === "openai-codex" || isBreadboardProviderFreeModel(model)) return null;
	const origin = session.modelRegistry.authStorage.keys.source(model.provider);
	if (origin?.kind === "oauth") return null;
	const usage = message.usage;
	if (
		![usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens].every(finiteNonNegative) ||
		usage.totalTokens === 0
	)
		return null;
	const rates = model.cost;
	if (![rates.input, rates.output, rates.cacheRead, rates.cacheWrite].some(rate => rate > 0)) return null;
	const cost = calculateCost(
		model,
		{ ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		message.timestamp,
	);
	return finiteNonNegative(cost.total) ? cost.total : null;
}

function readSpend(session: AgentSession): BreadboardComposerSpend | null {
	const messages = session.agent.state.messages;
	let turnStart = messages.length;
	while (turnStart > 0 && messages[turnStart - 1]?.role !== "user") turnStart--;
	const seen = new Set<string>();
	let sessionUsd = 0;
	let turnUsd = 0;
	let hasPrice = false;
	let hasTurnPrice = false;
	let sessionUnavailable = false;
	let turnUnavailable = false;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const projectionId = breadboardProjectionEventId(message);
		if (projectionId) {
			if (seen.has(projectionId)) continue;
			seen.add(projectionId);
		}
		const usd = messageSpend(session, message);
		const inCurrentTurn = index >= turnStart;
		if (usd === null) {
			sessionUnavailable = true;
			if (inCurrentTurn) turnUnavailable = true;
		} else {
			hasPrice = true;
			sessionUsd += usd;
			if (inCurrentTurn) {
				hasTurnPrice = true;
				turnUsd += usd;
			}
		}
	}
	if (!hasPrice) return null;
	return {
		sessionUsd: sessionUnavailable ? null : sessionUsd,
		turnUsd: hasTurnPrice && !turnUnavailable ? turnUsd : null,
		estimated: true,
	};
}

export function readBreadboardComposerMetrics(
	session: AgentSession,
	harness: HarnessSnapshot | null,
): BreadboardComposerMetrics {
	const revision = session.contextUsageRevision;
	const leafId = session.sessionManager.getLeafId();
	const model = session.model;
	let cached = transcriptMetrics.get(session);
	if (!cached || cached.revision !== revision || cached.leafId !== leafId || cached.model !== model) {
		cached = {
			revision,
			leafId,
			model,
			spend: readSpend(session),
		};
		transcriptMetrics.set(session, cached);
	}
	const effort = readHarnessEffort(session, harness);
	return {
		effort: effort ?? (session.mainStreamOwnsTurnLifecycle ? null : session.thinkingLevel),
		spend: cached.spend,
	};
}
