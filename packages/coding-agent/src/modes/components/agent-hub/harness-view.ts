import { visibleWidth } from "@oh-my-pi/pi-tui";
import { detectSensitiveValues } from "@breadboard/sdk/session";
import type { HarnessProvenance, HarnessSnapshot } from "../../../breadboard/harness-port";
import { theme } from "../../theme/theme";
import { bottomBorder, divider, row, topBorder } from "../overlay-box";

const REDACTED_DISPLAY = "<redacted>";
export type HarnessPanel = "overview" | "team" | "tools" | "prompts" | "compute" | "longrun" | "trust" | "evidence";

export interface HarnessViewDeps {
	readonly getSnapshot: () => HarnessSnapshot | null;
	readonly requestRender: () => void;
	readonly renderTabs: () => string;
}

const PANELS: readonly HarnessPanel[] = [
	"overview",
	"team",
	"tools",
	"prompts",
	"compute",
	"longrun",
	"trust",
	"evidence",
];

type RecordValue = Readonly<Record<string, unknown>>;

type HarnessField = {
	readonly label: string;
	readonly path: string;
	readonly value: unknown;
};

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function effectiveRows(lock: RecordValue, prefixes: readonly string[]): readonly HarnessField[] {
	const entries = lock.effective_values;
	if (!Array.isArray(entries)) return [];
	const fields: HarnessField[] = [];
	for (const entry of entries) {
		if (!isRecord(entry) || typeof entry.path !== "string") continue;
		const path = entry.path;
		if (entry.visibility === "redacted" || entry.value_kind === "secret-ref") continue;
		if (!prefixes.some(prefix => path === prefix || path.startsWith(`${prefix}.`))) continue;
		fields.push({ label: path, path, value: entry.value });
	}
	return fields;
}

function effectiveValue(lock: RecordValue, path: string): unknown {
	return effectiveRows(lock, [path])[0]?.value;
}

function firstField(fields: readonly HarnessField[], path: string, label: string): HarnessField | undefined {
	const field = fields.find(candidate => candidate.path === path);
	return field ? { ...field, label } : undefined;
}

function modeFields(lock: RecordValue): readonly HarnessField[] {
	const modes = effectiveValue(lock, "modes");
	if (!Array.isArray(modes)) return [];
	return modes.flatMap((mode, index) => {
		if (!isRecord(mode) || typeof mode.name !== "string" || mode.name.trim().length === 0) return [];
		return [{ label: `Mode ${index + 1}`, path: "modes", value: mode.name }];
	});
}

function safeText(value: string): string {
	const detection = detectSensitiveValues(value);
	return detection.findings.length > 0 || detection.truncated ? REDACTED_DISPLAY : value;
}

function displayValue(value: unknown): string {
	if (typeof value === "string") return safeText(value);
	if (typeof value === "number" || typeof value === "boolean") return safeText(String(value));
	try {
		const encoded = JSON.stringify(value);
		return encoded === undefined ? REDACTED_DISPLAY : safeText(encoded);
	} catch {
		return REDACTED_DISPLAY;
	}
}

function provenanceFor(snapshot: HarnessSnapshot, path: string): HarnessProvenance | undefined {
	return snapshot.provenance[path];
}

function provenanceSuffix(snapshot: HarnessSnapshot, path: string): string {
	const source = provenanceFor(snapshot, path);
	if (!source) return "";
	const location = source.line === null ? source.source : `${source.source}:${source.line}`;
	return `  ${theme.fg("dim", `(${location})`)}`;
}

function availableFields(fields: readonly HarnessField[]): readonly HarnessField[] {
	return fields.filter(field => field.value !== undefined && field.value !== null);
}

function panelFields(snapshot: HarnessSnapshot, panel: HarnessPanel): readonly HarnessField[] {
	const lock = snapshot.lock ?? {};
	let fields: readonly HarnessField[];
	switch (panel) {
		case "overview":
			fields = [
				{ label: "Name", path: "profile.name", value: snapshot.name },
				{ label: "Harness", path: "harness", value: snapshot.harnessId },
				{ label: "Lock hash", path: "lock_hash", value: snapshot.lockHash },
				{ label: "Generation", path: "generation", value: snapshot.generation },
				{ label: "Mode", path: "mode", value: snapshot.mode },
				...modeFields(lock),
			];
			break;
		case "team": {
			const teamFields = effectiveRows(lock, ["multi_agent.team_config.team"]);
			const teamSize = firstField(
				teamFields,
				"multi_agent.team_config.team.orchestration.scheduler.max_concurrent_agents",
				"Team size",
			);
			fields = teamSize ? [teamSize, ...teamFields.filter(field => field !== teamSize)] : teamFields;
			break;
		}
		case "tools":
			fields = effectiveRows(lock, ["tools", "provider_tools"]);
			break;
		case "prompts":
			fields = effectiveRows(lock, ["prompts"]);
			break;
		case "compute": {
			const computeFields = [
				...effectiveRows(lock, [
					"providers.default_model",
					"provider_tools.use_native",
					"provider_tools.api_variant",
					"modes",
				]),
			];
			const apiVariant = firstField(computeFields, "provider_tools.api_variant", "API variant");
			const nativeTools = firstField(computeFields, "provider_tools.use_native", "Native tools");
			const defaultModel = firstField(computeFields, "providers.default_model", "Default model");
			const modes = firstField(computeFields, "modes", "Modes");
			fields = [apiVariant, nativeTools, defaultModel, modes].filter(
				(field): field is HarnessField => field !== undefined,
			);
			break;
		}
		case "longrun":
			fields = effectiveRows(lock, ["long_running"]);
			break;
		case "trust":
			fields = effectiveRows(lock, [
				"workspace.sandbox",
				"workspace.mirror",
				"multi_agent.team_config.team.coordination",
			]);
			break;
		case "evidence":
			fields = [
				{ label: "Lock hash", path: "lock_hash", value: snapshot.lockHash },
				{ label: "Generation", path: "generation", value: snapshot.generation },
			];
			break;
	}
	return availableFields(fields);
}

export class HarnessView {
	#panel: HarnessPanel = "overview";

	constructor(private readonly deps: HarnessViewDeps) {}

	render(width: number, height: number): readonly string[] {
		const snapshot = this.deps.getSnapshot();
		const body: string[] = [this.deps.renderTabs(), ""];
		if (!snapshot) {
			body.push(theme.fg("muted", "No BreadBoard harness snapshot loaded."));
		} else {
			const panelIndex = PANELS.indexOf(this.#panel) + 1;
			body.push(theme.fg("accent", `Harness panel ${panelIndex}/${PANELS.length}: ${this.#panel}`), "");
			for (const field of panelFields(snapshot, this.#panel)) {
				body.push(
					`${theme.bold(field.label)}: ${displayValue(field.value)}${provenanceSuffix(snapshot, field.path)}`,
				);
			}
			if (
				this.#panel === "trust" &&
				effectiveRows(snapshot.lock ?? {}, ["permissions", "guardrails"]).length === 0
			) {
				body.push(theme.fg("muted", "No permissions.* or guardrails.* rows in the effective lock."));
			}
			if (this.#panel === "longrun" || this.#panel === "trust") {
				body.push("", theme.fg("dim", "Read-only configuration view."));
			}
			if (this.#panel === "evidence") {
				body.push("", theme.fg("dim", "Metadata only; credentials and secret values are never displayed."));
			}
			body.push("", theme.fg("dim", "j/k or ←/→: panel · Esc: close"));
		}
		const innerHeight = Math.max(1, height - 4);
		while (body.length < innerHeight) body.push("");
		const lines = [
			topBorder(width, "Agent Hub · Harness"),
			...body.slice(0, innerHeight).map(line => row(line, width)),
			divider(width),
			row(theme.fg("dim", "4: harness · 1/2/3: other sections · Esc: close"), width),
			bottomBorder(width),
		];
		return lines.map(line => (visibleWidth(line) > width ? line.slice(0, width) : line));
	}

	handleInput(key: string): boolean {
		if (key === "j" || key === "right") {
			this.#panel = PANELS[(PANELS.indexOf(this.#panel) + 1) % PANELS.length]!;
			this.deps.requestRender();
			return true;
		}
		if (key === "k" || key === "left") {
			this.#panel = PANELS[(PANELS.indexOf(this.#panel) + PANELS.length - 1) % PANELS.length]!;
			this.deps.requestRender();
			return true;
		}
		return false;
	}
}
