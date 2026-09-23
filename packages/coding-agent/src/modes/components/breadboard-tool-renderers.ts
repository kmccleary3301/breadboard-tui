import type { ToolRenderer } from "@oh-my-pi/pi-tui/tools";
import { registerToolRenderer, toolRenderers } from "@oh-my-pi/pi-tui/tools";

/**
 * Presentation aliases emitted by BreadBoard's effective tool bindings.
 * Each alias points at the existing OMP renderer instead of duplicating a card.
 */
export interface BreadBoardToolRendererBinding {
	readonly effectiveToolId: string;
	readonly ompToolId: string;
	readonly label: string;
}

const BINDING_BY_EFFECTIVE_ID: Readonly<Record<string, BreadBoardToolRendererBinding | undefined>> = Object.freeze({
	run_shell: { effectiveToolId: "run_shell", ompToolId: "bash", label: "Bash" },
	write: { effectiveToolId: "write", ompToolId: "write", label: "Write" },
	"todo.write_board": { effectiveToolId: "todo.write_board", ompToolId: "todo", label: "Todo" },
});

/** Stable alias metadata for tests, activity labels, and presentation callers. */
export const BREADBOARD_TOOL_RENDERER_BINDINGS = BINDING_BY_EFFECTIVE_ID;

for (const binding of Object.values(BINDING_BY_EFFECTIVE_ID)) {
	if (!binding) continue;
	const renderer = toolRenderers[binding.ompToolId];
	if (renderer) registerToolRenderer(binding.effectiveToolId, renderer, binding.label);
}

/** Resolve a BreadBoard effective tool id to the existing OMP renderer. */
export function getBreadBoardToolRenderer(effectiveToolId: string): ToolRenderer | undefined {
	const binding = BINDING_BY_EFFECTIVE_ID[effectiveToolId];
	return binding === undefined ? undefined : toolRenderers[binding.ompToolId];
}

/** Resolve the existing OMP-facing label for a BreadBoard effective tool id. */
export function getBreadBoardToolLabel(effectiveToolId: string): string | undefined {
	return BINDING_BY_EFFECTIVE_ID[effectiveToolId]?.label;
}
