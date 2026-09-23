import type { LoadedNativeHarness } from "@breadboard/harness";
import type { Settings } from "../config/settings";
import type { CreateAgentSessionOptions } from "../sdk";
import { createNativeHarnessExtension, nativeToolDelegates } from "./native-harness-extension";

/**
 * Configure an OMP session to run a compiled harness: its system prompt, exactly its function
 * tools, the built-ins those tools delegate to, and its approval policy. CLI `--model` and
 * `--approval-mode`/`--auto-approve` win over the harness.
 */
export function applyNativeHarnessSessionOptions(
	options: CreateAgentSessionOptions,
	harness: LoadedNativeHarness,
	activeSettings: Settings,
	cli: { readonly approvalSelected: boolean },
): void {
	options.systemPrompt = harness.systemPrompt;
	delete options.customSystemPrompt;
	delete options.appendSystemPrompt;
	// Python sends no date/cwd reminder; the harness prompt is the whole request prompt.
	options.dateCwdReminder = false;
	options.toolNames = harness.toolSurface.native.map(tool => tool.name);
	options.toolDelegates = nativeToolDelegates(harness);
	options.extensions = [...(options.extensions ?? []), createNativeHarnessExtension(harness)];
	if (options.model === undefined && options.modelPattern === undefined && harness.defaultModel !== undefined) {
		options.modelPattern = harness.defaultModel;
	}
	// Python's prompt mode asks before edits and shell (`permissions/broker.py:119-129`).
	if (harness.permissions.mode === "prompt" && !cli.approvalSelected) activeSettings.override("tools.approvalMode", "always-ask");
	// The harness owns todos through its TodoWrite tool; OMP's own todo reminders would add turns Python never sends.
	activeSettings.override("todo.enabled", false);
}
