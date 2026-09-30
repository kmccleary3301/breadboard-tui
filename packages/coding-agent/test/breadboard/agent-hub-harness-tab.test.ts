import { beforeAll, describe, expect, it } from "bun:test";
import type { HarnessPort } from "@oh-my-pi/pi-coding-agent/breadboard/harness-port";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { createAgentHubRuntime } from "@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-tui/overlays/agent-hub";
import { SessionObserverRegistry } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

describe("Agent hub harness section", () => {
	beforeAll(() => {
		initTheme();
	});

	it("shows the Harness tab only when a harness port is bound", () => {
		// Stock omp has no harness port; a Harness tab there would be BreadBoard UI leaking into upstream.
		const render = (harnessPort?: HarnessPort) => {
			const registry = new AgentRegistry();
			const hub = new AgentHubOverlayComponent({
				...createAgentHubRuntime({ registry, harnessPort }),
				registry,
				observers: new SessionObserverRegistry(),
				irc: new IrcBus(registry),
				hubKeys: [],
				onDone: () => {},
				requestRender: () => {},
			});
			try {
				hub.handleInput("2");
				return Bun.stripANSI(hub.render(120).join("\n"));
			} finally {
				hub.dispose();
			}
		};
		const stock = render();
		expect(stock).toContain("3 Messages");
		expect(stock).not.toContain("Harness");
		expect(render({ current: () => null, refresh: async () => null, subscribe: () => () => {} })).toContain(
			"4 Harness",
		);
	});
});
