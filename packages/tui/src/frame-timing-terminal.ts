import { dlopen, FFIType, type Library, ptr } from "bun:ffi";
import type {
	CursorShape,
	GlyphProtocolReportHandler,
	PrivateModeReportHandler,
	Terminal,
	TerminalAppearance,
	TerminalAppearanceRequestToken,
	TerminalStartOptions,
} from "./terminal.js";

export function timingNonce(): string | undefined {
	const nonce = process.env.OMP_TUI_TIMING_NONCE;
	return nonce !== undefined && /^[0-9a-f]{32}$/.test(nonce) ? nonce : undefined;
}

export interface FrameTimingMetadata {
	version: 1;
	frameId: number;
	inputId: number;
	inputData: string;
	inputAtMs: number | null;
	writtenAtMs: number;
	monotonicOriginMs: number | null;
	clockUncertaintyMs: number | null;
}

const MACH_TIME_SYMBOLS = {
	mach_absolute_time: { args: [], returns: FFIType.u64 },
	mach_timebase_info: { args: [FFIType.ptr], returns: FFIType.i32 },
} as const;
type MachTimeLibrary = Library<typeof MACH_TIME_SYMBOLS>;
let machTimeLibrary: MachTimeLibrary | undefined;
let machTimebase: { numer: number; denom: number } | undefined;

export function machAbsoluteTimeMs(): number | undefined {
	if (process.platform !== "darwin") return undefined;
	try {
		const library = (machTimeLibrary ??= dlopen("/usr/lib/libSystem.B.dylib", MACH_TIME_SYMBOLS));
		if (machTimebase === undefined) {
			const timebase = new Uint32Array(2);
			if (library.symbols.mach_timebase_info(ptr(timebase)) !== 0 || timebase[1] === 0) return undefined;
			machTimebase = { numer: timebase[0]!, denom: timebase[1]! };
		}
		return (Number(library.symbols.mach_absolute_time()) * machTimebase.numer) / machTimebase.denom / 1e6;
	} catch {
		return undefined;
	}
}

export function encodeFrameTimingTrailer(nonce: string, frame: FrameTimingMetadata): string {
	const payload = Buffer.from(JSON.stringify(frame), "utf8").toString("base64");
	return `\x1b]777;omp-frame-timing;${nonce};${payload}\x07`;
}

export interface FrameTimingClock {
	now(): number;
}

export class FrameTimingTerminal implements Terminal {
	readonly #underlying: Terminal;
	readonly #nonce: string;
	readonly #clock: FrameTimingClock;
	#frameId = 0;
	#inputId = 0;
	#inputData = "";
	#inputAtMs: number | null = null;

	constructor(underlying: Terminal, nonce: string, clock: FrameTimingClock = { now: () => performance.now() }) {
		this.#underlying = underlying;
		this.#nonce = nonce;
		this.#clock = clock;
	}

	get underlying(): Terminal {
		return this.#underlying;
	}

	get nonce(): string {
		return this.#nonce;
	}

	get frameId(): number {
		return this.#frameId;
	}

	get inputId(): number {
		return this.#inputId;
	}

	get inputData(): string {
		return this.#inputData;
	}

	get inputAtMs(): number | null {
		return this.#inputAtMs;
	}

	recordInput(data: string): void {
		this.#inputAtMs = this.#clock.now();
		this.#inputId += 1;
		this.#inputData = Buffer.from(data, "utf8").toString("base64");
	}

	writeFrame(buffer: string): void {
		const bracketStartMs = machAbsoluteTimeMs();
		const writtenAtMs = this.#clock.now();
		const bracketEndMs = machAbsoluteTimeMs();
		this.#underlying.write(buffer);
		const mappingValid =
			bracketStartMs !== undefined &&
			bracketEndMs !== undefined &&
			Number.isFinite(bracketStartMs) &&
			Number.isFinite(bracketEndMs) &&
			Number.isFinite(writtenAtMs) &&
			bracketEndMs >= bracketStartMs;
		const monotonicOriginMs = mappingValid ? (bracketStartMs + bracketEndMs) / 2 - writtenAtMs : null;
		const clockUncertaintyMs = mappingValid
			? (bracketEndMs - bracketStartMs) / 2 +
				2 * Number.EPSILON * (Math.abs(bracketStartMs) + Math.abs(bracketEndMs) + Math.abs(writtenAtMs))
			: null;
		this.#underlying.write(
			encodeFrameTimingTrailer(this.#nonce, {
				version: 1,
				frameId: this.#frameId,
				inputId: this.#inputId,
				inputData: this.#inputData,
				inputAtMs: this.#inputAtMs,
				writtenAtMs,
				monotonicOriginMs,
				clockUncertaintyMs,
			}),
		);
		this.#frameId += 1;
	}

	// Terminal implementation delegating to underlying terminal
	get columns(): number {
		return this.#underlying.columns;
	}

	get rows(): number {
		return this.#underlying.rows;
	}

	get pendingOutputBytes(): number | undefined {
		return this.#underlying.pendingOutputBytes;
	}

	get hostOwnsGridOnResize(): boolean | undefined {
		return this.#underlying.hostOwnsGridOnResize;
	}

	get kittyProtocolActive(): boolean {
		return this.#underlying.kittyProtocolActive;
	}

	get kittyEnableSequence(): string | null {
		return this.#underlying.kittyEnableSequence;
	}

	get keyboardEnhancementEnterSequence(): string | null | undefined {
		return this.#underlying.keyboardEnhancementEnterSequence;
	}

	get keyboardEnhancementExitSequence(): string | null | undefined {
		return this.#underlying.keyboardEnhancementExitSequence;
	}

	get appearance(): TerminalAppearance | undefined {
		return this.#underlying.appearance;
	}

	start(
		onInput: (data: string) => void,
		onResize: () => void,
		onDisconnect?: () => void,
		options?: TerminalStartOptions,
	): void {
		this.#underlying.start(onInput, onResize, onDisconnect, options);
	}

	enableInput(): void {
		this.#underlying.enableInput?.();
	}

	stop(): void {
		this.#underlying.stop();
	}

	drainInput(maxMs?: number, idleMs?: number): Promise<void> {
		return this.#underlying.drainInput(maxMs, idleMs);
	}

	write(data: string): void {
		this.#underlying.write(data);
	}

	moveBy(lines: number): void {
		this.#underlying.moveBy(lines);
	}

	hideCursor(force?: boolean): void {
		this.#underlying.hideCursor(force);
	}

	showCursor(force?: boolean): void {
		this.#underlying.showCursor(force);
	}

	setCursorShape(shape: CursorShape): void {
		this.#underlying.setCursorShape?.(shape);
	}

	clearLine(): void {
		this.#underlying.clearLine();
	}

	clearFromCursor(): void {
		this.#underlying.clearFromCursor();
	}

	clearScreen(): void {
		this.#underlying.clearScreen();
	}

	setTitle(title: string): void {
		this.#underlying.setTitle(title);
	}

	setProgress(active: boolean): void {
		this.#underlying.setProgress(active);
	}

	onAppearanceChange(
		callback: (appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void,
	): void {
		this.#underlying.onAppearanceChange(callback);
	}

	onAppearanceReport(
		callback: (appearance: TerminalAppearance, requestToken?: TerminalAppearanceRequestToken) => void,
	): (() => void) | void {
		return this.#underlying.onAppearanceReport?.(callback);
	}

	refreshAppearance(requestToken?: TerminalAppearanceRequestToken): TerminalAppearanceRequestToken | void {
		return this.#underlying.refreshAppearance?.(requestToken);
	}

	onPrivateModeReport(callback: PrivateModeReportHandler): void {
		this.#underlying.onPrivateModeReport?.(callback);
	}

	onGlyphProtocolReport(callback: GlyphProtocolReportHandler): void {
		this.#underlying.onGlyphProtocolReport?.(callback);
	}
}

export function wrapTerminalForFrameTiming(
	terminal: Terminal,
	clock?: FrameTimingClock,
	timingNonceOverride?: string,
): Terminal {
	const nonce = timingNonceOverride ?? timingNonce();
	if (nonce === undefined) return terminal;
	if (terminal instanceof FrameTimingTerminal) return terminal;
	return new FrameTimingTerminal(terminal, nonce, clock);
}
