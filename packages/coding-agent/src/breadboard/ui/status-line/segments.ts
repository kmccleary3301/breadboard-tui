import { sanitizeStatusText } from "@oh-my-pi/pi-tui/chrome/shared";
import { theme } from "@oh-my-pi/pi-tui/theme/theme";
import { truncateToWidth } from "@oh-my-pi/pi-tui";
import type { StatusLineSegment } from "@oh-my-pi/pi-tui/status-line/types";
import { renderBreadboardPolicy } from "./breadboard-presentation";

const TRUNCATE_LENGTHS = {
	SHORT: 20,
};

export const harnessSegment: StatusLineSegment = {
	id: "harness",
	render(ctx) {
		const harness = ctx.harness;
		if (!harness) return { content: "", visible: false };
		const options = ctx.options.harness;
		const name = options?.showGeneration === false ? harness.name.replace(/\.(?:harness|ya?ml)$/u, "") : harness.name;
		const parts = [truncateToWidth(sanitizeStatusText(name), options?.maxLength ?? TRUNCATE_LENGTHS.SHORT)];
		if (harness.mode) parts.push(truncateToWidth(sanitizeStatusText(harness.mode), TRUNCATE_LENGTHS.SHORT));
		if (options?.showGeneration !== false && harness.generation) {
			const generation = sanitizeStatusText(harness.generation);
			parts.push(`g${generation.startsWith("sha256:") ? generation.slice(7, 15) : generation.slice(0, 8)}`);
		}
		return { content: theme.fg("accent", parts.join(" · ")), visible: true };
	},
};

export const breadboardPolicySegment: StatusLineSegment = {
	id: "bb_policy",
	render(ctx) {
		const content = renderBreadboardPolicy(ctx.harness);
		return { content, visible: content.length > 0 };
	},
};
