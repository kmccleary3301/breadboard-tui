import * as fs from "node:fs";
import type { AgentHubDeps, AgentHubRemote, AgentHubViewFactory } from "@oh-my-pi/pi-tui/overlays/agent-hub";
import type { AgentTranscriptSource } from "@oh-my-pi/pi-tui/overlays/agent-transcript-viewer";
import { nativeControlRestriction } from "../breadboard/native-control-policy";
import type { HarnessPort, HarnessSnapshot } from "../breadboard/harness-port";
import { AgentActivityIndex } from "../activity";
import { getRoleInfo } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { AgentHubMessagesView } from "./components/agent-hub/messages-view";
import { HarnessView, type HarnessPanel } from "./components/agent-hub/harness-view";
import { IrcBus } from "../irc/bus";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "../registry/agent-registry";
import { registerPersistedSubagents } from "../registry/persisted-agents";
import { parseSessionEntries } from "../session/session-loader";

/** Filesystem and parser used by local and host-backed transcript viewers. */
export const agentTranscriptSource: AgentTranscriptSource = {
	fs,
	parseEntries: text =>
		parseSessionEntries(text).filter(entry => entry.type === "message" || entry.type === "model_change"),
};

/** Host services used by the roster, without exposing runtime implementation to tui. */
export function createAgentHubRuntime(
	options: {
		registry?: AgentRegistry;
		lifecycle?: AgentLifecycleManager;
		irc?: IrcBus;
		activity?: AgentActivityIndex;
		remote?: AgentHubRemote;
		settings?: Settings;
		sessionFile?: string | null;
		harnessPort?: HarnessPort;
		mainStreamOwnsTurnLifecycle?: boolean;
	} = {},
): Pick<
	AgentHubDeps<AgentRef>,
	| "registry"
	| "lifecycle"
	| "irc"
	| "activity"
	| "manageActivityLive"
	| "transcript"
	| "loadPersisted"
	| "getRoleInfo"
	| "viewFactory"
	| "nativeMutationRestriction"
> {
	const registry = options.registry ?? AgentRegistry.global();
	const irc = options.irc ?? IrcBus.global();
	const activity = options.activity ?? new AgentActivityIndex({ remote: options.remote });
	const viewFactory: AgentHubViewFactory<AgentRef> = context => ({
		messages: new AgentHubMessagesView({
			registry,
			irc,
			remote: options.remote,
			renderTabs: context.renderTabs,
			requestRender: context.requestRender,
			onDone: context.onDone,
			switchSection: () => context.switchSection("activity"),
			managePeer: context.managePeer,
			mutationRestriction: context.mutationRestriction,
		}),
		harness: new HarnessView({
			getSnapshot: () => (options.harnessPort?.current() ?? context.harnessSnapshot()) as HarnessSnapshot | null,
			initialPanel: context.initialHarnessPanel as HarnessPanel | undefined,
			renderTabs: context.renderTabs,
		}),
	});
	return {
		registry,
		lifecycle: () => options.lifecycle ?? AgentLifecycleManager.global(),
		irc,
		activity,
		manageActivityLive: !options.activity,
		transcript: agentTranscriptSource,
		loadPersisted: shouldContinue => registerPersistedSubagents(registry, options.sessionFile, { shouldContinue }),
		getRoleInfo: options.settings ? role => getRoleInfo(role, options.settings!) : undefined,
		viewFactory,
		nativeMutationRestriction: () => nativeControlRestriction("subagents", options.mainStreamOwnsTurnLifecycle === true),
	};
}
