/**
 * Regression for #2084: `createSessionManager` must reject with
 * `SessionResolutionError` (and a usage hint) when `--resume` / `--fork` are
 * given a non-existent session id, so `runRootCommand` can convert it into a
 * clean stderr message + non-zero exit instead of letting it surface as
 * `[Uncaught Exception]`.
 */
import { describe, expect, it, vi } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	BreadboardSessionTransitionError,
	createBreadboardStartupForkPolicy,
	createSessionManager,
	resolveBreadboardSessionTarget,
	SessionResolutionError,
	writeStartupNotice,
} from "@oh-my-pi/pi-coding-agent/main";
import * as sessionListingModule from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function buildResumeArgs(resume: string, sessionDir?: string): Args {
	return {
		resume,
		sessionDir,
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
	};
}

function buildContinueArgs(message: string, sessionDir?: string): Args {
	return {
		continue: true,
		sessionDir,
		messages: [message],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
	};
}

function buildForkArgs(fork: string, noSession = false): Args {
	return {
		fork,
		noSession: noSession || undefined,
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
	};
}

const stubSettings = { get: () => undefined, getRaw: () => undefined } as unknown as Settings;

const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);
const ORIGINAL_STDERR_WRITE = process.stderr.write.bind(process.stderr);

function captureProcessOutput(): { read: () => { stdout: string; stderr: string }; restore: () => void } {
	let stdout = "";
	let stderr = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stderr.write;
	return {
		read: () => ({ stdout, stderr }),
		restore: () => {
			process.stdout.write = ORIGINAL_STDOUT_WRITE;
			process.stderr.write = ORIGINAL_STDERR_WRITE;
		},
	};
}

describe("writeStartupNotice", () => {
	it("writes notices to stdout outside JSON mode", () => {
		const capture = captureProcessOutput();
		try {
			writeStartupNotice({}, "hello\n");
			expect(capture.read()).toEqual({ stdout: "hello\n", stderr: "" });
		} finally {
			capture.restore();
		}
	});

	it("keeps JSON mode stdout clean by writing notices to stderr", () => {
		const capture = captureProcessOutput();
		try {
			writeStartupNotice({ mode: "json" }, "hello\n");
			expect(capture.read()).toEqual({ stdout: "", stderr: "hello\n" });
		} finally {
			capture.restore();
		}
	});
});

describe("createSessionManager — missing session (#2084)", () => {
	it("rejects --resume with SessionResolutionError carrying a usage hint", async () => {
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(undefined);
		try {
			await expect(
				createSessionManager(
					buildResumeArgs("019ea530-0000-7000-0000-000000000000"),
					"/current/project",
					stubSettings,
				),
			).rejects.toMatchObject({
				name: "SessionResolutionError",
				message: 'Session "019ea530-0000-7000-0000-000000000000" not found.',
				hint: expect.stringContaining("omp --resume"),
			});

			// Confirm it's the exported class so `runRootCommand`'s `instanceof` check works.
			const caught = await createSessionManager(
				buildResumeArgs("019ea530-0000-7000-0000-000000000000"),
				"/current/project",
				stubSettings,
			).catch((err: unknown) => err);
			expect(caught).toBeInstanceOf(SessionResolutionError);
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("rejects --resume with unknown id instead of falling back to latest persisted session", async () => {
		const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-resume-unknown-id-"));
		const sessionDir = path.join(cwd, "sessions");
		const missingId = "019ea530-ffff-7000-8000-000000000000";
		try {
			const latest = SessionManager.create(cwd, sessionDir);
			latest.appendMessage({ role: "user", content: "newer persisted session", timestamp: Date.now() });
			await latest.rewriteEntries();
			const latestSessionId = latest.getSessionId();
			expect(latestSessionId).not.toBe(missingId);

			await expect(
				createSessionManager(buildResumeArgs(missingId, sessionDir), cwd, stubSettings),
			).rejects.toMatchObject({
				name: "SessionResolutionError",
				message: `Session "${missingId}" not found.`,
				hint: expect.stringContaining("omp --resume"),
			});
		} finally {
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});

	it("rejects --continue followed by an unknown session id instead of falling back to latest", async () => {
		const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-continue-unknown-id-"));
		const sessionDir = path.join(cwd, "sessions");
		const missingId = "019ea530-ffff-7000-8000-000000000000";
		try {
			const latest = SessionManager.create(cwd, sessionDir);
			latest.appendMessage({ role: "user", content: "latest should not be resumed", timestamp: Date.now() });
			await latest.rewriteEntries();
			expect(latest.getSessionId()).not.toBe(missingId);

			await expect(
				createSessionManager(buildContinueArgs(missingId, sessionDir), cwd, stubSettings),
			).rejects.toMatchObject({
				name: "SessionResolutionError",
				message: `Session "${missingId}" not found.`,
				hint: expect.stringContaining("omp --resume"),
			});
		} finally {
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});

	it("rejects --fork with SessionResolutionError carrying a usage hint", async () => {
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(undefined);
		try {
			await expect(
				createSessionManager(
					buildForkArgs("019ea530-0000-7000-0000-000000000000"),
					"/current/project",
					stubSettings,
				),
			).rejects.toMatchObject({
				name: "SessionResolutionError",
				message: 'Session "019ea530-0000-7000-0000-000000000000" not found.',
				hint: expect.stringContaining("omp --resume"),
			});
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("rejects --fork combined with --no-session as a SessionResolutionError (no hint)", async () => {
		await expect(
			createSessionManager(buildForkArgs("019ea530", true), "/current/project", stubSettings),
		).rejects.toMatchObject({
			name: "SessionResolutionError",
			message: "--fork requires session persistence",
			hint: undefined,
		});
	});

	it("keeps unconfigured startup forks on the native OMP path", () => {
		const policy = createBreadboardStartupForkPolicy({}, stubSettings, os.tmpdir());
		expect(policy).not.toThrow();
	});

	it("rejects product startup forks without forcing installed artifact resolution", () => {
		const selectedLocalOwned = {
			get: () => undefined,
			getRaw: (key: string) => (key === "breadboard" ? { engineMode: "local-owned" } : undefined),
		} as unknown as Settings;
		const cases: Array<{
			readonly parsed: Pick<Args, "engineMode" | "engineUrl">;
			readonly settings: Settings;
		}> = [
			{ parsed: {}, settings: stubSettings },
			{ parsed: { engineMode: "local-owned" }, settings: stubSettings },
			{ parsed: {}, settings: selectedLocalOwned },
		];
		for (const testCase of cases) {
			const policy = createBreadboardStartupForkPolicy(testCase.parsed, testCase.settings, os.tmpdir(), true, true);
			let thrown: unknown;
			try {
				policy();
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(BreadboardSessionTransitionError);
			expect(thrown).toMatchObject({ code: "unsupported_resume_transition" });
		}
	});

	it("allows an explicit product off mode startup fork", () => {
		const policy = createBreadboardStartupForkPolicy({ engineMode: "off" }, stubSettings, os.tmpdir(), true, true);
		expect(policy).not.toThrow();
	});
});

describe("resolveBreadboardSessionTarget", () => {
	const workspace = "/canonical/project";
	const binding = (overrides: Record<string, unknown> = {}) => ({
		schemaVersion: "breadboard.session-binding.v3",
		sessionId: "bb-session",
		replayConfigurationDigest: "sha256:replay",
		cursor: { eventId: "event-1", sequence: 1 },
		ownedSubmissions: [],
		...overrides,
	});
	const manager = (...bindings: unknown[]) =>
		({
			getBranch: () =>
				bindings.map(data => ({
					type: "custom" as const,
					customType: "breadboard.session-binding",
					data,
				})),
		}) as Parameters<typeof resolveBreadboardSessionTarget>[1];

	it("creates a default-profile session with the canonical workspace", () => {
		expect(resolveBreadboardSessionTarget({}, undefined, undefined, workspace, true)).toEqual({
			kind: "create",
			request: { workspace },
		});
	});

	it("preserves an explicit session config path with the canonical workspace", () => {
		const configPath = "/profiles/daily_driver.v1.yaml";
		expect(resolveBreadboardSessionTarget({}, undefined, configPath, workspace, true)).toEqual({
			kind: "create",
			request: { configPath, workspace },
		});
	});

	it("keeps native explicit-engine creation invalid without a selected config", () => {
		let thrown: unknown;
		try {
			resolveBreadboardSessionTarget({}, undefined, undefined, workspace, false);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toMatchObject({
			code: "invalid_session_config",
			field: "sessionConfigPath",
		});
	});

	it("attaches the durable binding for resume and continue before create logic", () => {
		const sessionManager = manager(binding());
		const parsedCases: Pick<Args, "continue" | "resume">[] = [
			{ resume: true },
			{ resume: "session-file" },
			{ continue: true },
		];
		for (const parsed of parsedCases) {
			expect(resolveBreadboardSessionTarget(parsed, sessionManager, undefined, workspace, true)).toEqual({
				kind: "attach",
				sessionId: "bb-session",
			});
		}
	});

	it("rejects colliding or stale durable bindings", () => {
		expect(() =>
			resolveBreadboardSessionTarget(
				{ resume: true },
				manager(binding(), binding({ sessionId: "other-session" })),
				undefined,
				workspace,
				true,
			),
		).toThrow("conflicts with the active transcript");
		expect(() =>
			resolveBreadboardSessionTarget(
				{ resume: true },
				manager(binding(), binding({ cursor: { eventId: null, sequence: 0 } })),
				undefined,
				workspace,
				true,
			),
		).toThrow("conflicts with the active transcript");
	});

	it("rejects malformed durable bindings instead of creating a new session", () => {
		expect(() =>
			resolveBreadboardSessionTarget(
				{ continue: true },
				manager({ schemaVersion: "breadboard.session-binding.v3" }),
				undefined,
				workspace,
				true,
			),
		).toThrow("malformed or incompatible");
	});
});
