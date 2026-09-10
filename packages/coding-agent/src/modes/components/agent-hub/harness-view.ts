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

function effectiveValue(lock: RecordValue, path: string): unknown {
	const entries = lock.effective_values;
	if (Array.isArray(entries)) {
		for (const entry of entries) {
			if (!isRecord(entry) || entry.path !== path) continue;
			if (entry.visibility === "redacted") return REDACTED_DISPLAY;
			return entry.value;
		}
	}
	return undefined;
}

function valueAt(lock: RecordValue, path: string): unknown {
	const projected = effectiveValue(lock, path);
	if (projected !== undefined) return projected;
	let value: unknown = lock;
	for (const part of path.split(".")) {
		if (!isRecord(value)) return undefined;
		value = value[part];
	}
	if (isRecord(value) && value.visibility === "redacted") return REDACTED_DISPLAY;
	return value;
}

function firstValue(lock: RecordValue, paths: readonly string[]): { readonly path: string; readonly value: unknown } {
	for (const path of paths) {
		const value = valueAt(lock, path);
		if (value !== undefined && value !== null) return { path, value };
	}
	return { path: paths[0] ?? "", value: undefined };
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

function modeFields(lock: RecordValue): readonly HarnessField[] {
	const modes = valueAt(lock, "modes");
	if (Array.isArray(modes)) {
		return modes.flatMap((mode, index) => {
			if (!isRecord(mode) || typeof mode.name !== "string" || mode.name.trim().length === 0) return [];
			return [{ label: `Mode ${index + 1}`, path: `modes.${index}.name`, value: mode.name }];
		});
	}
	const entries = lock.effective_values;
	if (!Array.isArray(entries)) return [];
	return entries
		.flatMap(entry => {
			if (!isRecord(entry) || typeof entry.path !== "string" || !/^modes\.\d+\.name$/u.test(entry.path)) return [];
			if (entry.visibility === "redacted" || typeof entry.value !== "string" || entry.value.trim().length === 0) return [];
			const index = Number(entry.path.split(".")[1]);
			return [{ label: `Mode ${index + 1}`, path: entry.path, value: entry.value, index }];
		})
		.sort((left, right) => left.index - right.index)
		.map(({ index: _index, ...field }) => field);
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
		case "team":
			fields = [
				{
					label: "Team size",
					path: "multi_agent.team_config.team.orchestration.scheduler.max_concurrent_agents",
					value: valueAt(lock, "multi_agent.team_config.team.orchestration.scheduler.max_concurrent_agents"),
				},
			];
			break;
		case "tools":
			{
				const packs = firstValue(lock, ["tool_packs", "tools.packs"]);
				const bindings = firstValue(lock, ["bindings", "tools.bindings"]);
				const hidden = firstValue(lock, ["why_hidden", "tools.why_hidden", "tools.why-hidden"]);
				fields = [
					{ label: "Packs", path: packs.path, value: packs.value },
					{ label: "Bindings", path: bindings.path, value: bindings.value },
					{ label: "Why hidden", path: hidden.path, value: hidden.value },
				];
			}
			break;
		case "prompts":
			fields = [{ label: "Prompts", path: "prompts", value: valueAt(lock, "prompts") }];
			break;
		case "compute":
			fields = [
				{ label: "API variant", path: "provider_tools.api_variant", value: valueAt(lock, "provider_tools.api_variant") },
				{ label: "Native tools", path: "provider_tools.use_native", value: valueAt(lock, "provider_tools.use_native") },
			];
			break;
		case "longrun":
			fields = [{ label: "Enabled", path: "long_running.enabled", value: valueAt(lock, "long_running.enabled") }];
			break;
		case "trust":
			fields = [{ label: "Trust", path: "trust", value: valueAt(lock, "trust") }];
			break;
		case "evidence":
			{
				const extendsChain = firstValue(lock, ["extends", "extends_chain"]);
				const checkpoints = firstValue(lock, ["checkpoint_paths", "checkpoints", "checkpoint"]);
				const evidence = firstValue(lock, ["evidence_paths", "evidence"]);
				fields = [
					{ label: "Lock hash", path: "lock_hash", value: snapshot.lockHash },
					{ label: "Generation", path: "generation", value: snapshot.generation },
					{ label: "Extends", path: extendsChain.path, value: extendsChain.value },
					{ label: "Checkpoint paths", path: checkpoints.path, value: checkpoints.value },
					{ label: "Evidence paths", path: evidence.path, value: evidence.value },
				];
			}
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
					`${theme.bold(safeText(field.label))}: ${displayValue(field.value)}${provenanceSuffix(snapshot, field.path)}`,
				);
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
