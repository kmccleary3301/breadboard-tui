import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AsyncJobType } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { AsyncJobSnapshotItem } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";
import { StatusLineTestComponents } from "./helpers/status-line";

let settingsState: SettingsTestState | undefined;
const statusLines = new StatusLineTestComponents();

beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterEach(() => {
	statusLines.dispose();
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

function runningJob(type: AsyncJobType, index: number): AsyncJobSnapshotItem {
	const id = `${type}-${index}`;
	return {
		id,
		type,
		status: "running",
		label: `${type} ${index}`,
		startTime: index,
		agentId: type === "task" ? id : undefined,
	};
}

function makeComponent(running: AsyncJobSnapshotItem[], state: { isStreaming: boolean } = { isStreaming: false }): StatusLineComponent {
	const messages: unknown[] = [];
	const model = { id: "test-model", name: "Test Model", contextWindow: 100_000 };
	const session = {
		state: { messages, model },
		messages,
		model,
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		get isStreaming() {
			return state.isStreaming;
		},
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isAdvisorActive: () => false,
		getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
		getAsyncJobSnapshot: () => ({ running }),
		settings: { get: () => false },
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => undefined,
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
		getContextUsage: () => undefined,
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
	const component = statusLines.track(new StatusLineComponent(session, statusLineHost));
	component.updateSettings({
		preset: "custom",
		leftSegments: [],
		rightSegments: [],
		separator: "none",
		transparent: true,
	});
	return component;
}

describe("status-line background-job badge", () => {
	it("counts non-task jobs without duplicating running task subagents", () => {
		const running = [runningJob("task", 0), runningJob("bash", 1), runningJob("eval", 2)];
		const component = makeComponent(running);
		component.setRunningSubagents(["task-0"]);

		const content = stripVTControlCharacters(component.getTopBorder(120).content);
		expect(content).toContain(`${theme.icon.agents} 1`);
		expect(content).toContain(`${theme.icon.job} 2`);
	});

	it("counts queued task jobs before their subagent is registered", () => {
		const component = makeComponent([runningJob("task", 0)]);
		component.setRunningSubagents([]);
		const content = stripVTControlCharacters(component.getTopBorder(120).content);
		expect(content).toContain(`${theme.icon.job} 1`);
	});
});

describe("BreadBoard composer while background jobs hold the turn", () => {
	// Native turns never set BreadBoard activity; the composer derives it from session state.
	function render(component: StatusLineComponent): string {
		return stripVTControlCharacters(component.getTopBorder(160).content);
	}

	function makeBreadboardComponent(running: AsyncJobSnapshotItem[], state: { isStreaming: boolean }) {
		const component = makeComponent(running, state);
		component.updateSettings({ preset: "bb-balanced" });
		component.markActivityStart();
		return component;
	}

	it("reports the background wait instead of Working once the turn stops streaming", () => {
		const state = { isStreaming: true };
		const component = makeBreadboardComponent([runningJob("bash", 1)], state);
		const streaming = render(component);
		expect(streaming).toContain("Working");
		expect(streaming).not.toContain("Waiting on");

		state.isStreaming = false;
		component.invalidate();
		const waiting = render(component);
		expect(waiting).toContain("Waiting on 1 background job");
		expect(waiting).not.toContain("Working");
	});

	it("counts jobs as the stock badge does and keeps operator states ahead of the wait", () => {
		const component = makeBreadboardComponent(
			[runningJob("task", 0), runningJob("bash", 1), runningJob("eval", 2)],
			{ isStreaming: false },
		);
		component.setRunningSubagents(["task-0"]);
		component.invalidate();
		expect(render(component)).toContain("Waiting on 2 background jobs");

		component.setBreadboardActivity({ kind: "approval", label: "Approval required" });
		const approval = render(component);
		expect(approval).toContain("Approval required");
		expect(approval).not.toContain("Waiting on");
	});

	it("shows no activity once the turn has ended", () => {
		const component = makeBreadboardComponent([runningJob("bash", 1)], { isStreaming: false });
		component.markActivityEnd();
		component.invalidate();
		const idle = render(component);
		expect(idle).not.toContain("Waiting on");
		expect(idle).not.toContain("Working");
	});
});
