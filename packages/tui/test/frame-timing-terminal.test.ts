import { describe, expect, it } from "bun:test";
import {
	encodeFrameTimingTrailer,
	FrameTimingTerminal,
	timingNonce,
	wrapTerminalForFrameTiming,
} from "../src/frame-timing-terminal";
import { VirtualTerminal } from "./virtual-terminal";

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

describe("FrameTimingTerminal", () => {
	it("validates timing nonce format", () => {
		const originalNonce = process.env.OMP_TUI_TIMING_NONCE;
		try {
			delete process.env.OMP_TUI_TIMING_NONCE;
			expect(timingNonce()).toBeUndefined();

			process.env.OMP_TUI_TIMING_NONCE = "short";
			expect(timingNonce()).toBeUndefined();

			process.env.OMP_TUI_TIMING_NONCE = "0123456789abcdef0123456789ABCDEF"; // uppercase invalid
			expect(timingNonce()).toBeUndefined();

			process.env.OMP_TUI_TIMING_NONCE = "0123456789abcdef0123456789abcdef"; // 32 hex lowercase
			expect(timingNonce()).toBe("0123456789abcdef0123456789abcdef");
		} finally {
			if (originalNonce !== undefined) process.env.OMP_TUI_TIMING_NONCE = originalNonce;
			else delete process.env.OMP_TUI_TIMING_NONCE;
		}
	});

	it("delegates terminal properties and operations to underlying terminal", () => {
		const term = new RecordingTerminal(80, 24);
		const timingTerm = new FrameTimingTerminal(term, "0123456789abcdef0123456789abcdef", { now: () => 100 });

		expect(timingTerm.columns).toBe(80);
		expect(timingTerm.rows).toBe(24);
		expect(timingTerm.underlying).toBe(term);

		timingTerm.write("hello");
		expect(term.writes).toEqual(["hello"]);
	});

	it("records input and emits trailers with exact byte structure", () => {
		const term = new RecordingTerminal(80, 24);
		let clockTime = 1000;
		const clock = { now: () => clockTime };
		const nonce = "0123456789abcdef0123456789abcdef";
		const timingTerm = new FrameTimingTerminal(term, nonce, clock);

		// Initial frame before any input
		timingTerm.writeFrame("\x1b[2Jframe-0");
		expect(term.writes.length).toBe(2);
		expect(term.writes[0]).toBe("\x1b[2Jframe-0");

		const trailer0 = term.writes[1]!;
		expect(trailer0.startsWith(`\x1b]777;omp-frame-timing;${nonce};`)).toBe(true);
		expect(trailer0.endsWith("\x07")).toBe(true);

		const parsed0 = JSON.parse(
			Buffer.from(trailer0.slice(`\x1b]777;omp-frame-timing;${nonce};`.length, -1), "base64").toString("utf8"),
		);
		expect(parsed0).toMatchObject({
			version: 1,
			frameId: 0,
			inputId: 0,
			inputData: "",
			inputAtMs: null,
			writtenAtMs: 1000,
		});

		// User input arrives
		clockTime = 1050;
		timingTerm.recordInput("test-key");
		expect(timingTerm.inputId).toBe(1);
		expect(timingTerm.inputData).toBe(Buffer.from("test-key", "utf8").toString("base64"));
		expect(timingTerm.inputAtMs).toBe(1050);

		// Next frame
		clockTime = 1060;
		timingTerm.writeFrame("\x1b[2Jframe-1");
		expect(term.writes.length).toBe(4);
		expect(term.writes[2]).toBe("\x1b[2Jframe-1");

		const trailer1 = term.writes[3]!;
		const parsed1 = JSON.parse(
			Buffer.from(trailer1.slice(`\x1b]777;omp-frame-timing;${nonce};`.length, -1), "base64").toString("utf8"),
		);
		expect(parsed1).toMatchObject({
			version: 1,
			frameId: 1,
			inputId: 1,
			inputData: Buffer.from("test-key", "utf8").toString("base64"),
			inputAtMs: 1050,
			writtenAtMs: 1060,
		});
	});

	it("wrapTerminalForFrameTiming only wraps when valid nonce is configured", () => {
		const term = new RecordingTerminal(80, 24);
		const originalNonce = process.env.OMP_TUI_TIMING_NONCE;
		try {
			delete process.env.OMP_TUI_TIMING_NONCE;
			const unwrapped = wrapTerminalForFrameTiming(term);
			expect(unwrapped).toBe(term);

			process.env.OMP_TUI_TIMING_NONCE = "0123456789abcdef0123456789abcdef";
			const wrapped = wrapTerminalForFrameTiming(term);
			expect(wrapped).toBeInstanceOf(FrameTimingTerminal);
			expect((wrapped as FrameTimingTerminal).underlying).toBe(term);

			// Idempotent wrap
			const wrappedAgain = wrapTerminalForFrameTiming(wrapped);
			expect(wrappedAgain).toBe(wrapped);
		} finally {
			if (originalNonce !== undefined) process.env.OMP_TUI_TIMING_NONCE = originalNonce;
			else delete process.env.OMP_TUI_TIMING_NONCE;
		}
	});

	it("encodes frame timing trailers according to OSC 777 omp-frame-timing spec", () => {
		const nonce = "0123456789abcdef0123456789abcdef";
		const trailer = encodeFrameTimingTrailer(nonce, {
			version: 1,
			frameId: 42,
			inputId: 5,
			inputData: Buffer.from("abc", "utf8").toString("base64"),
			inputAtMs: 123.45,
			writtenAtMs: 234.56,
			monotonicOriginMs: 1000.5,
			clockUncertaintyMs: 0.05,
		});
		expect(trailer.startsWith(`\x1b]777;omp-frame-timing;${nonce};`)).toBe(true);
		expect(trailer.endsWith("\x07")).toBe(true);
		const payload = JSON.parse(
			Buffer.from(trailer.slice(`\x1b]777;omp-frame-timing;${nonce};`.length, -1), "base64").toString("utf8"),
		);
		expect(payload).toEqual({
			version: 1,
			frameId: 42,
			inputId: 5,
			inputData: "YWJj",
			inputAtMs: 123.45,
			writtenAtMs: 234.56,
			monotonicOriginMs: 1000.5,
			clockUncertaintyMs: 0.05,
		});
	});
});
