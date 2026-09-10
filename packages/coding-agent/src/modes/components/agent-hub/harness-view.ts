import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { HarnessSnapshot } from "../../../breadboard/harness-port";
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

function valueAt(lock: Readonly<Record<string, unknown>>, key: string): unknown {
	let value: unknown = lock;
	for (const part of key.split(".")) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		value = (value as Readonly<Record<string, unknown>>)[part];
	}
	return value;
}

function displayValue(value: unknown): string {
	if (value === undefined) return "—";
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value);
}

export class HarnessView {
	#panel: HarnessPanel = "overview";
	constructor(private readonly deps: HarnessViewDeps) {}

	render(width: number, height: number): readonly string[] {
		const snapshot = this.deps.getSnapshot();
		const body: string[] = [this.deps.renderTabs(), ""];
		if (!snapshot) body.push(theme.fg("muted", "No BreadBoard harness snapshot loaded."));
		else {
			const panelIndex = PANELS.indexOf(this.#panel) + 1;
			body.push(theme.fg("accent", `Harness panel ${panelIndex}/${PANELS.length}: ${this.#panel}`), "");
			const fields: readonly [string, string][] =
				this.#panel === "overview"
					? [
							["Name", snapshot.name],
							["Harness", snapshot.harnessId],
							["Lock", snapshot.lockHash ?? "—"],
							["Generation", snapshot.generation ?? "—"],
							["Mode", snapshot.mode ?? "—"],
						]
					: [
							[
								this.#panel,
								displayValue(
									valueAt(snapshot.lock ?? {}, this.#panel === "longrun" ? "long_running" : this.#panel),
								),
							],
						];
			for (const [label, value] of fields) {
				const source = snapshot.provenance[label.toLowerCase()] ?? snapshot.provenance[this.#panel];
				const provenance = source
					? theme.fg("dim", `  (${source.source}${source.line === null ? "" : `:${source.line}`})`)
					: "";
				body.push(`${theme.bold(label)}: ${value}${provenance}`);
			}
			body.push("", theme.fg("dim", "j/k or ←/→: panel · p: provenance · Esc: close"));
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
