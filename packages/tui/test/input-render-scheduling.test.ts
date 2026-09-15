import { describe, expect, it, vi } from "bun:test";
import { type Component, type RenderTimer, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

class InputProbe implements Component {
	constructor(private readonly events: string[]) {}

	invalidate(): void {}

	render(_width: number): readonly string[] {
		this.events.push("render");
		return ["probe"];
	}

	handleInput(_data: string): void {
		this.events.push("input");
	}
}

class SelfRenderingInputProbe implements Component {
	constructor(
		private readonly events: string[],
		private readonly requestOwnRender: () => void,
	) {}

	invalidate(): void {}

	render(_width: number): readonly string[] {
		this.events.push("render");
		return ["probe"];
	}

	handleInput(_data: string): void {
		this.events.push("input");
		this.requestOwnRender();
	}
}

class ReentrantInputProbe implements Component {
	#injected = false;

	constructor(
		private readonly events: string[],
		private readonly injectInput: () => void,
	) {}

	invalidate(): void {}

	render(_width: number): readonly string[] {
		this.events.push("render");
		if (!this.#injected) {
			this.#injected = true;
			this.injectInput();
		}
		return ["probe"];
	}

	handleInput(_data: string): void {
		this.events.push("input");
	}
}

class DeferredRenderScheduler {
	nowMs = 0;
	readonly immediates: Array<() => void> = [];
	readonly timers: Array<{ callback: () => void; canceled: boolean }> = [];

	now(): number {
		return this.nowMs;
	}

	scheduleImmediate(callback: () => void): void {
		this.immediates.push(callback);
	}

	scheduleRender(callback: () => void, _delayMs: number): RenderTimer {
		const timer = { callback, canceled: false };
		this.timers.push(timer);
		return {
			cancel: () => {
				timer.canceled = true;
			},
		};
	}
}

describe("TUI input/render scheduling", () => {
	it("can commit a priority frame without waiting for queued immediates", () => {
		const term = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const events: string[] = [];
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(new InputProbe(events));

		try {
			tui.start();
			tui.renderNow();
			expect(events).toEqual(["render"]);

			for (const immediate of scheduler.immediates.splice(0)) immediate();
			expect(events).toEqual(["render"]);
		} finally {
			tui.stop();
		}
	});

	it("can process terminal input before a deferred ordinary repaint", () => {
		const term = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const events: string[] = [];
		const probe = new InputProbe(events);
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(probe);
		tui.setFocus(probe);

		try {
			tui.start();
			scheduler.immediates.shift()?.();
			const initialTimer = scheduler.timers.shift();
			if (initialTimer && !initialTimer.canceled) initialTimer.callback();
			events.length = 0;
			scheduler.nowMs = 100;

			tui.requestRender();
			term.sendInput("x");
			scheduler.immediates.shift()?.();

			expect(events).toEqual(["input", "render"]);
		} finally {
			tui.stop();
		}
	});

	it("prioritizes non-interrupt user input past cadence", () => {
		const term = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const events: string[] = [];
		const probe = new InputProbe(events);
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(probe);
		tui.setFocus(probe);

		try {
			tui.start();
			scheduler.immediates.shift()?.();
			const initialTimer = scheduler.timers.shift();
			if (initialTimer && !initialTimer.canceled) initialTimer.callback();
			events.length = 0;

			term.sendInput("x");
			expect(events).toEqual(["input", "render"]);
			expect(scheduler.immediates).toEqual([]);
			expect(scheduler.timers.filter(timer => !timer.canceled)).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("does not append a forced frame after a component renders synchronously", () => {
		const term = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const events: string[] = [];
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const probe = new SelfRenderingInputProbe(events, () => tui.renderNow());
		tui.addChild(probe);
		tui.setFocus(probe);

		try {
			tui.start();
			scheduler.immediates.splice(0);
			events.length = 0;

			term.sendInput("\r");
			expect(events).toEqual(["input", "render"]);
			for (const immediate of scheduler.immediates.splice(0)) immediate();
			expect(events).toEqual(["input", "render"]);
		} finally {
			tui.stop();
		}
	});

	it("upgrades a component-owned ordinary repaint without forcing the viewport", () => {
		const term = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const events: string[] = [];
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const probe = new SelfRenderingInputProbe(events, () => tui.requestRender());
		tui.addChild(probe);
		tui.setFocus(probe);

		try {
			tui.start();
			scheduler.immediates.shift()?.();
			const initialTimer = scheduler.timers.shift();
			if (initialTimer && !initialTimer.canceled) initialTimer.callback();
			events.length = 0;

			term.sendInput("/");
			expect(events).toEqual(["input", "render"]);
			for (const immediate of scheduler.immediates.splice(0)) immediate();
			expect(events).toEqual(["input", "render"]);
			expect(scheduler.timers.filter(timer => !timer.canceled)).toEqual([]);
		} finally {
			tui.stop();
		}
	});

	it("defers input that re-enters during a terminal frame write", () => {
		const term = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const events: string[] = [];
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const probe = new ReentrantInputProbe(events, () => term.sendInput("x"));
		tui.addChild(probe);
		tui.setFocus(probe);

		try {
			tui.start();
			scheduler.immediates.splice(0);
			tui.renderNow();
			expect(events).toEqual(["render", "input"]);

			const followUp = scheduler.timers.find(timer => !timer.canceled);
			expect(followUp).toBeDefined();
			followUp?.callback();
			expect(events).toEqual(["render", "input", "render"]);
		} finally {
			tui.stop();
		}
	});

	it("runs a coalesced post-paint callback after a cadence-delayed render", async () => {
		const term = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const events: string[] = [];
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(new InputProbe(events));

		try {
			tui.start();
			scheduler.immediates.shift()?.();
			const initialTimer = scheduler.timers.shift();
			if (initialTimer && !initialTimer.canceled) initialTimer.callback();
			events.length = 0;

			const afterPaint = () => events.push("after-paint");
			tui.requestRenderAfterPaint(afterPaint);
			tui.requestRenderAfterPaint(afterPaint);
			scheduler.immediates.shift()?.();

			expect(events).toEqual([]);
			const requestedTimer = scheduler.timers.shift();
			if (requestedTimer && !requestedTimer.canceled) requestedTimer.callback();
			expect(events).toEqual(["render"]);
			await Promise.resolve();
			expect(events).toEqual(["render", "after-paint"]);
		} finally {
			tui.stop();
		}
	});

	it("drops pending post-paint callbacks when stopped before the render", async () => {
		const term = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const afterPaint = vi.fn();

		try {
			tui.start();
			tui.renderNow();
			tui.requestRenderAfterPaint(afterPaint);
			tui.stop();

			tui.start();
			tui.renderNow();
			await Promise.resolve();
			expect(afterPaint).not.toHaveBeenCalled();
		} finally {
			tui.stop();
		}
	});

	it("abandons the painted callback batch when one callback restarts the TUI", async () => {
		const term = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const staleCallback = vi.fn();

		try {
			tui.start();
			tui.renderNow();
			tui.requestRenderAfterPaint(() => {
				tui.stop();
				tui.start();
			});
			tui.requestRenderAfterPaint(staleCallback);
			tui.renderNow();

			await Promise.resolve();
			expect(staleCallback).not.toHaveBeenCalled();
		} finally {
			tui.stop();
		}
	});
});
