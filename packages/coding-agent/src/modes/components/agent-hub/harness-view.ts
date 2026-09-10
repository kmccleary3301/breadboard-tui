import { visibleWidth } from "@oh-my-pi/pi-tui";
import { detectSensitiveValues, REDACTED_VALUE } from "@breadboard/sdk/session";
import type { HarnessProvenance, HarnessSnapshot } from "../../../breadboard/harness-port";
import { theme } from "../../theme/theme";
import { bottomBorder, divider, row, topBorder } from "../overlay-box";

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

function valueAt(lock: RecordValue, path: string): unknown {
	let value: unknown = lock;
	for (const part of path.split(".")) {
		if (!isRecord(value)) return undefined;
		value = value[part];
	}
	return value;
}

function firstValue(lock: RecordValue, paths: readonly string[]): { readonly path: string; readonly value: unknown } {
	for (const path of paths) {
		const value = valueAt(lock, path);
		if (value !== undefined) return { path, value };
	}
	return { path: paths[0] ?? "", value: undefined };
}

function safeText(value: string): string {
	const detection = detectSensitiveValues(value);
	return detection.findings.length > 0 || detection.truncated ? REDACTED_VALUE : value;
}

function displayValue(value: unknown): string {
	if (value === undefined) return "—";
	if (typeof value === "string") return safeText(value);
	if (typeof value === "number" || typeof value === "boolean" || value === null) return safeText(String(value));
	try {
		const encoded = JSON.stringify(value);
		return encoded === undefined ? "—" : safeText(encoded);
	} catch {
		return REDACTED_VALUE;
	}
}

function provenanceFor(snapshot: HarnessSnapshot, path: string): HarnessProvenance | undefined {
	return snapshot.provenance[path] ?? snapshot.provenance[path.split(".")[0] ?? path];
}

function provenanceSuffix(snapshot: HarnessSnapshot, path: string): string {
	const source = provenanceFor(snapshot, path);
	if (!source) return "";
	const location = source.line === null ? source.source : `${source.source}:${source.line}`;
	return `  ${theme.fg("dim", `(${safeText(location)})`)}`;
}

function panelFields(snapshot: HarnessSnapshot, panel: HarnessPanel): readonly HarnessField[] {
	const lock = snapshot.lock ?? {};
	switch (panel) {
		case "overview":
			return [
				{ label: "Name", path: "profile.name", value: snapshot.name },
				{ label: "Harness", path: "harness", value: snapshot.harnessId },
				{ label: "Lock hash", path: "lock_hash", value: snapshot.lockHash },
				{ label: "Generation", path: "generation", value: snapshot.generation },
				{ label: "Mode", path: "mode", value: snapshot.mode },
			];
		case "team":
			return [{ label: "Team", path: "team", value: valueAt(lock, "team") }];
		case "tools": {
			const packs = firstValue(lock, ["tool_packs", "tools.packs"]);
			const bindings = firstValue(lock, ["bindings", "tools.bindings"]);
			const hidden = firstValue(lock, ["why_hidden", "tools.why_hidden", "tools.why-hidden"]);
			return [
				{ label: "Packs", path: packs.path, value: packs.value },
				{ label: "Bindings", path: bindings.path, value: bindings.value },
				{ label: "Why hidden", path: hidden.path, value: hidden.value },
			];
		}
		case "prompts":
			return [{ label: "Prompts", path: "prompts", value: valueAt(lock, "prompts") }];
		case "compute":
			return [{ label: "Compute", path: "compute", value: valueAt(lock, "compute") }];
		case "longrun":
			return [{ label: "Long-run", path: "long_running", value: valueAt(lock, "long_running") }];
		case "trust":
			return [{ label: "Trust", path: "trust", value: valueAt(lock, "trust") }];
		case "evidence": {
			const extendsChain = firstValue(lock, ["extends", "extends_chain"]);
			const checkpoints = firstValue(lock, ["checkpoint_paths", "checkpoints", "checkpoint"]);
			const evidence = firstValue(lock, ["evidence_paths", "evidence"]);
			return [
				{ label: "Lock hash", path: "lock_hash", value: snapshot.lockHash },
				{ label: "Generation", path: "generation", value: snapshot.generation },
				{ label: "Extends", path: extendsChain.path, value: extendsChain.value },
				{ label: "Checkpoint paths", path: checkpoints.path, value: checkpoints.value },
				{ label: "Evidence paths", path: evidence.path, value: evidence.value },
			];
		}
	}
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
