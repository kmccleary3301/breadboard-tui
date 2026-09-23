import { matchesKey, visibleWidth } from "@oh-my-pi/pi-tui";
import { detectSensitiveValues } from "@breadboard/sdk/session";
import type { HarnessProvenance, HarnessSnapshot } from "../../../breadboard/harness-port";
import { theme } from "@oh-my-pi/pi-tui/theme/theme";
import { bottomBorder, divider, row, topBorder } from "@oh-my-pi/pi-tui/overlays/overlay-box";

const REDACTED_DISPLAY = "<redacted>";
export type HarnessPanel = "overview" | "team" | "tools" | "prompts" | "compute" | "longrun" | "trust" | "evidence";

export interface HarnessViewDeps {
	readonly getSnapshot: () => HarnessSnapshot | null;
	readonly requestRender: () => void;
	readonly renderTabs: () => string;
	readonly initialPanel?: HarnessPanel;
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

export type HarnessField = {
	readonly label: string;
	readonly path: string;
	readonly value: unknown;
};

export type HarnessPanelFields = Readonly<Record<HarnessPanel, readonly HarnessField[]>>;

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

const PANEL_PREFIXES: Readonly<Record<HarnessPanel, readonly string[]>> = {
	overview: ["schema_version", "version"],
	team: ["multi_agent"],
	tools: ["tools", "provider_tools"],
	prompts: ["prompts"],
	compute: ["completion", "loop", "features", "concurrency", "providers", "modes"],
	longrun: ["long_running"],
	trust: ["workspace"],
	evidence: [],
};

function projectedPanelFields(lock: RecordValue): HarnessPanelFields {
	return {
		overview: effectiveRows(lock, PANEL_PREFIXES.overview),
		team: effectiveRows(lock, PANEL_PREFIXES.team),
		tools: effectiveRows(lock, PANEL_PREFIXES.tools),
		prompts: effectiveRows(lock, PANEL_PREFIXES.prompts),
		compute: effectiveRows(lock, PANEL_PREFIXES.compute),
		longrun: effectiveRows(lock, PANEL_PREFIXES.longrun),
		trust: effectiveRows(lock, PANEL_PREFIXES.trust),
		evidence: effectiveRows(lock, PANEL_PREFIXES.evidence),
	};
}

/** All visible effective lock leaves, with each canonical prefix owned by one panel. */
export function projectHarnessEffectiveRowsByPanel(lock: RecordValue): HarnessPanelFields {
	return projectedPanelFields(lock);
}

/** All visible effective lock leaves projected once into their owning panel. */
export function projectHarnessEffectiveRows(lock: RecordValue): readonly HarnessField[] {
	const panels = projectedPanelFields(lock);
	return PANELS.flatMap(panel => panels[panel]);
}

function panelEffectiveRows(lock: RecordValue, panel: HarnessPanel): readonly HarnessField[] {
	return effectiveRows(lock, PANEL_PREFIXES[panel]);
}

function effectiveValue(lock: RecordValue, path: string): unknown {
	const entry = effectiveRows(lock, [path]).find(field => field.path === path);
	return entry?.value;
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
	return fields.filter(field => field.value !== undefined);
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
				{
					label: "Configuration details",
					path: "configuration_details",
					value:
						snapshot.lock === null
							? "Unavailable: source lock is missing or does not match this session"
							: "Verified against session lock",
				},
				{ label: "Generation", path: "generation", value: snapshot.generation },
				{ label: "Mode", path: "mode", value: snapshot.mode },
				...panelEffectiveRows(lock, panel),
				...modeFields(lock),
			];
			break;
		case "team": {
			const teamFields = panelEffectiveRows(lock, panel);
			const teamSize = firstField(
				teamFields,
				"multi_agent.team_config.team.orchestration.scheduler.max_concurrent_agents",
				"Team size",
			);
			fields = teamSize ? [teamSize, ...teamFields.filter(field => field !== teamSize)] : teamFields;
			break;
		}
		case "tools":
			fields = panelEffectiveRows(lock, panel);
			break;
		case "prompts":
			fields = panelEffectiveRows(lock, panel);
			break;
		case "compute":
			fields = panelEffectiveRows(lock, panel).map(field => {
				const label =
					field.path === "providers.default_model"
						? "Default model"
						: field.path === "modes"
							? "Modes"
							: field.label;
				return { ...field, label };
			});
			break;
		case "longrun":
			fields = panelEffectiveRows(lock, panel);
			break;
		case "trust":
			fields = panelEffectiveRows(lock, panel);
			break;
		case "evidence":
			fields = [
				{ label: "Lock hash", path: "lock_hash", value: snapshot.lockHash ?? undefined },
				{ label: "Generation", path: "generation", value: snapshot.generation ?? undefined },
			];
			break;
	}
	return availableFields(fields);
}

export class HarnessView {
	#panel: HarnessPanel;

	constructor(private readonly deps: HarnessViewDeps) {
		this.#panel = deps.initialPanel ?? "overview";
	}

	render(width: number, height: number): readonly string[] {
		const snapshot = this.deps.getSnapshot();
		const body: string[] = [this.deps.renderTabs(), ""];
		if (!snapshot) {
			body.push(theme.fg("muted", "No BreadBoard harness snapshot loaded."));
		} else {
			const panelIndex = PANELS.indexOf(this.#panel) + 1;
			body.push(theme.fg("accent", `Harness panel ${panelIndex}/${PANELS.length}: ${this.#panel}`), "");
			const fields = panelFields(snapshot, this.#panel);
			for (const field of fields) {
				body.push(
					`${theme.bold(field.label)}: ${displayValue(field.value)}${provenanceSuffix(snapshot, field.path)}`,
				);
			}
			if (fields.length === 0) {
				if (this.#panel === "team") {
					body.push(theme.fg("muted", "No multi_agent.* rows in the effective lock."));
				} else if (this.#panel === "prompts") {
					body.push(theme.fg("muted", "No prompts.* rows in the effective lock."));
				} else if (this.#panel === "evidence") {
					body.push(theme.fg("muted", "No lock or generation metadata is available."));
				}
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
		if (key === "j" || matchesKey(key, "right")) {
			this.#panel = PANELS[(PANELS.indexOf(this.#panel) + 1) % PANELS.length]!;
			this.deps.requestRender();
			return true;
		}
		if (key === "k" || matchesKey(key, "left")) {
			this.#panel = PANELS[(PANELS.indexOf(this.#panel) + PANELS.length - 1) % PANELS.length]!;
			this.deps.requestRender();
			return true;
		}
		return false;
	}
}
