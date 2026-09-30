import {
	createNativeHarnessExtension,
	type LoadedNativeHarness,
	nativeCacheRetention,
	nativeStatefulResponses,
	nativeToolDelegates,
} from "@breadboard/harness";
import type { Settings } from "../config/settings";
import { cfgProvidersCacheRetention } from "../session/settings";
import { cfgTodoEnabled, cfgToolsApprovalMode, cfgToolsIntentTracing } from "../tools/settings";
import type { CreateAgentSessionOptions } from "../sdk";

/**
 * Configure an OMP session to run a compiled harness. A harness with its own surface supplies the
 * system prompt, exactly its function tools, the built-ins those tools delegate to, and its approval
 * policy. A host-surface harness (`bb-omp.native`) leaves OMP's tools, prompt, settings and prompt
 * inputs as they are and only appends its prompt blocks. CLI `--model` and
 * `--approval-mode`/`--auto-approve` win over the harness.
 */
export function applyNativeHarnessSessionOptions(
	options: CreateAgentSessionOptions,
	harness: LoadedNativeHarness,
	activeSettings: Settings,
	cli: { readonly approvalSelected: boolean },
): void {
	options.extensions = [...(options.extensions ?? []), createNativeHarnessExtension(harness)];
	if (options.model === undefined && options.modelPattern === undefined && harness.defaultModel !== undefined) {
		options.modelPattern = harness.defaultModel;
	}
	// Python's prompt mode asks before edits and shell (`permissions/broker.py:119-129`).
	if (harness.permissions.mode === "prompt" && !cli.approvalSelected)
		cfgToolsApprovalMode.override(activeSettings, "always-ask");
	if (harness.hostSurface) return;

	options.systemPrompt = harness.systemPrompt;
	delete options.customSystemPrompt;
	delete options.appendSystemPrompt;
	// Python sends no date/cwd reminder; the harness prompt is the whole request prompt.
	options.dateCwdReminder = false;
	options.toolNames = harness.toolSurface.native.map(tool => tool.name);
	options.toolDelegates = nativeToolDelegates(harness);
	// The harness owns todos through its TodoWrite tool; OMP's own todo reminders would add turns Python never sends.
	cfgTodoEnabled.override(activeSettings, false);
	// Python sends the compiled tool schemas unchanged; OMP's intent field would add a required `i` property.
	cfgToolsIntentTracing.override(activeSettings, false);
	// Python caches the system prompt exactly as the harness declares; OMP's default retention depends on the auth type.
	const cacheRetention = nativeCacheRetention(harness);
	if (cacheRetention !== undefined) cfgProvidersCacheRetention.override(activeSettings, cacheRetention);
	// Python replays the full transcript when the lock turns off Responses chaining.
	const statefulResponses = nativeStatefulResponses(harness);
	if (statefulResponses !== undefined) options.statefulResponses = statefulResponses;
}
