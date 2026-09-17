import { describe, expect, it, vi } from "bun:test";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";
import type { ShakeMode } from "@oh-my-pi/pi-coding-agent/session/shake-types";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

function acpRuntime() {
	const shake = vi.fn(async (mode: ShakeMode) => ({
		mode,
		toolResultsDropped: 1,
		blocksDropped: 0,
		imagesDropped: mode === "images" ? 1 : undefined,
		tokensFreed: 100,
	}));
	const output = vi.fn();
	const runtime = { session: { shake }, output } as unknown as SlashCommandRuntime;
	return { shake, output, runtime };
}

function tuiRuntime() {
	const handleShakeCommand = vi.fn(async () => {});
	const setText = vi.fn();
	const showWarning = vi.fn();
	const runtime = {
		ctx: createInteractiveModeContext({
			editor: { setText },
			handleShakeCommand,
			showWarning,
		}),
	};
	return { handleShakeCommand, setText, showWarning, runtime };
}

describe("/shake dispatch (ACP)", () => {
	it("rejects an unknown mode without invoking shake", async () => {
		const h = acpRuntime();
		const result = await executeAcpBuiltinSlashCommand("/shake bogus", h.runtime);
		expect(h.shake).not.toHaveBeenCalled();
		expect(result).toEqual({ consumed: true });
		expect((h.output.mock.calls[0]?.[0] as string) ?? "").toContain("bogus");
	});
});

describe("/shake dispatch (TUI)", () => {
	it("warns on an unknown mode and does not run a shake", async () => {
		const h = tuiRuntime();
		await executeBuiltinSlashCommand("/shake nope", h.runtime);
		expect(h.handleShakeCommand).not.toHaveBeenCalled();
		expect(h.showWarning).toHaveBeenCalled();
	});
});
describe("CommandController /shake", () => {
	it("reports thinking-only drops and rebuilds the transcript", async () => {
		const rebuildChatFromMessages = vi.fn();
		const invalidate = vi.fn();
		const requestRender = vi.fn();
		const showStatus = vi.fn();
		const ctx = createInteractiveModeContext({
			session: {
				shake: vi.fn(async () => ({
					mode: "thinking" as const,
					toolResultsDropped: 0,
					blocksDropped: 0,
					thinkingBlocksDropped: 2,
					tokensFreed: 0,
				})),
			},
			rebuildChatFromMessages,
			statusLine: { invalidate },
			ui: { requestRender },
			showStatus,
			showError: vi.fn(),
		});

		await new CommandController(ctx).handleShakeCommand("thinking");

		expect(rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(showStatus).toHaveBeenCalledWith("Dropped 2 thinking blocks from this session.");
	});
});
