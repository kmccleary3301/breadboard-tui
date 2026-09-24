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
import {
	createBreadboardStartupForkPolicy,
	resolveBreadboardSessionTarget,
} from "@oh-my-pi/pi-coding-agent/breadboard/runtime";
import { BreadboardSessionTransitionError } from "@oh-my-pi/pi-coding-agent/breadboard/session-binding";
import type { Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager, SessionResolutionError, writeStartupNotice } from "@oh-my-pi/pi-coding-agent/main";
import * as sessionListingModule from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { loadSessionFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { ForkSourceNotFoundError, SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

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
function buildForkArgs(fork: string, noSession = false, sessionDir?: string): Args {
	return {
		fork,
		noSession: noSession || undefined,
		sessionDir,
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
	it("rejects --fork with missing path without writing a session (#11491)", async () => {
		const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-fork-missing-path-"));
		const sessionDir = path.join(cwd, "sessions");
		const missingPath = path.join(cwd, "ghost-zz9q.jsonl");
		try {
			await expect(
				createSessionManager(buildForkArgs(missingPath, false, sessionDir), cwd, stubSettings),
			).rejects.toMatchObject({
				name: "SessionResolutionError",
				message: `Session "${missingPath}" not found.`,
				hint: expect.stringContaining("omp --resume"),
			});
			await expect(fsp.readdir(sessionDir)).resolves.toEqual([]);
		} finally {
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});

	it("forkFrom rejects a missing source without writing a session (#11491)", async () => {
		const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-fork-missing-path-"));
		const sessionDir = path.join(cwd, "sessions");
		const missingPath = path.join(cwd, "ghost-zz9q.jsonl");
		try {
			const caught = await SessionManager.forkFrom(missingPath, cwd, sessionDir).catch((err: unknown) => err);
			expect(caught).toBeInstanceOf(ForkSourceNotFoundError);
			expect(caught).toMatchObject({
				message: `Session "${missingPath}" not found.`,
			});
			await expect(fsp.readdir(sessionDir)).resolves.toEqual([]);
		} finally {
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});

	it("forkFrom rejects a vanished source on the streaming path (#11491)", async () => {
		const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-fork-missing-path-"));
		const sessionDir = path.join(cwd, "sessions");
		const missingPath = path.join(cwd, "ghost-zz9q.jsonl");
		const storage = new FileSessionStorage();
		const realStatSync = storage.statSync.bind(storage);
		vi.spyOn(storage, "statSync").mockImplementation(((filePath: string) =>
			filePath === missingPath
				? { size: 8 * 1024 * 1024, mtimeMs: Date.now(), mtime: new Date() }
				: realStatSync(filePath)) as typeof storage.statSync);
		try {
			const caught = await SessionManager.forkFrom(missingPath, cwd, sessionDir, storage).catch(
				(err: unknown) => err,
			);
			expect(caught).toBeInstanceOf(ForkSourceNotFoundError);
			await expect(fsp.readdir(sessionDir)).resolves.toEqual([]);
		} finally {
			vi.restoreAllMocks();
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});

	it("rejects --fork <id> when resolved session vanished before forkFrom reads it (#11491)", async () => {
		const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-fork-vanished-id-"));
		const sessionDir = path.join(cwd, "sessions");
		const vanishedPath = path.join(cwd, "vanished.jsonl");
		const forkId = "019ea530-0000-7000-0000-000000000000";
		const session: sessionListingModule.SessionInfo = {
			id: forkId,
			path: vanishedPath,
			cwd,
			title: "vanished",
			created: new Date(0),
			modified: new Date(0),
			messageCount: 0,
			size: 0,
			firstMessage: "",
			allMessagesText: "",
		};
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue({
			session,
			scope: "local",
		});
		try {
			await expect(
				createSessionManager(buildForkArgs(forkId, false, sessionDir), cwd, stubSettings),
			).rejects.toMatchObject({
				name: "SessionResolutionError",
				message: `Session "${forkId}" not found.`,
				hint: expect.stringContaining("omp --resume"),
			});
			await expect(fsp.readdir(sessionDir)).resolves.toEqual([]);
		} finally {
			vi.restoreAllMocks();
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});

	it("rejects --fork with ENOTDIR path without writing a session (#11491)", async () => {
		const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-fork-enotdir-"));
		const sessionDir = path.join(cwd, "sessions");
		const regularFile = path.join(cwd, "file.txt");
		await Bun.write(regularFile, "not a directory");
		const enotdirChild = path.join(regularFile, "child.jsonl");
		try {
			await expect(
				createSessionManager(buildForkArgs(enotdirChild, false, sessionDir), cwd, stubSettings),
			).rejects.toMatchObject({
				name: "SessionResolutionError",
				message: `Session "${enotdirChild}" not found.`,
				hint: expect.stringContaining("omp --resume"),
			});
			await expect(fsp.readdir(sessionDir)).resolves.toEqual([]);
		} finally {
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});

	it("propagates ENOTDIR on ordinary session loads when throwIfMissing is false (#11491)", async () => {
		const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-enotdir-ordinary-"));
		const regularFile = path.join(cwd, "file.txt");
		await Bun.write(regularFile, "not a directory");
		const enotdirChild = path.join(regularFile, "child.jsonl");
		try {
			await expect(loadSessionFile(enotdirChild)).rejects.toMatchObject({
				code: "ENOTDIR",
			});
		} finally {
			await fsp.rm(cwd, { recursive: true, force: true });
		}
	});

	it("rejects --resume combined with --no-session instead of silently discarding it (#12008)", async () => {
		await expect(
			createSessionManager({ ...buildResumeArgs("019ea530"), noSession: true }, "/current/project", stubSettings),
		).rejects.toMatchObject({
			name: "SessionResolutionError",
			message: "--resume requires session persistence",
			hint: undefined,
		});
	});

	it("defers --resume + --no-session rejection while extension flag ownership is unresolved", async () => {
		const manager = await createSessionManager(
			{ ...buildResumeArgs("019ea530"), noSession: true },
			"/current/project",
			stubSettings,
			async () => "unavailable",
			{ nativeFlagOwnership: "preliminary" },
		);

		expect(manager?.getEntries()).toEqual([]);
	});

	it("rejects the --resume picker (no value) combined with --no-session (#12008)", async () => {
		await expect(
			createSessionManager(
				{ ...buildResumeArgs("019ea530"), resume: true, noSession: true },
				"/current/project",
				stubSettings,
			),
		).rejects.toMatchObject({
			name: "SessionResolutionError",
			message: "--resume requires session persistence",
		});
	});

	it("rejects --continue combined with --no-session (#12008)", async () => {
		await expect(
			createSessionManager(
				{ ...buildContinueArgs("hello there"), noSession: true },
				"/current/project",
				stubSettings,
			),
		).rejects.toMatchObject({
			name: "SessionResolutionError",
			message: "--continue requires session persistence",
		});
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

	it("allows default product native mode startup fork", () => {
		const policy = createBreadboardStartupForkPolicy({}, stubSettings, os.tmpdir(), true, true);
		expect(policy).not.toThrow();
	});
});

describe("resolveBreadboardSessionTarget", () => {
	const workspace = "/canonical/project";
	const binding = (overrides: Record<string, unknown> = {}) => ({
		schemaVersion: "breadboard.session-binding.v4",
		sessionId: "bb-session",
		previousSessionId: null,
		replayConfigurationDigest: "sha256:replay",
		cursor: { eventId: "event-1", sequence: 1 },
		ownedSubmissions: [],
		...overrides,
	});
	const manager = (...bindings: unknown[]) => ({
		getBranch: () =>
			bindings.map(data => ({
				type: "custom" as const,
				customType: "breadboard.session-binding",
				data,
			})),
	});

	it("creates a default-profile session with the canonical workspace", () => {
		expect(resolveBreadboardSessionTarget({}, undefined, undefined, workspace, true)).toEqual({
			kind: "create",
			request: { permissionMode: "configured", workspace },
		});
	});

	it("preserves an explicit session config path with the canonical workspace", () => {
		const configPath = "/profiles/daily_driver.v1.yaml";
		expect(resolveBreadboardSessionTarget({}, undefined, configPath, workspace, true)).toEqual({
			kind: "create",
			request: { configPath, permissionMode: "configured", workspace },
		});
	});

	it("keeps the YAML config path and adds a sibling lock id when present", async () => {
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), "bb-harness-lock-"));
		try {
			const harnessPath = path.join(root, "agent_configs/v2/daily_driver.v1.yaml");
			await fsp.mkdir(path.dirname(harnessPath), { recursive: true });
			await fsp.writeFile(harnessPath, "profile: {}\n");
			await fsp.writeFile(`${harnessPath.slice(0, -5)}.lock.json`, "{}\n");
			expect(
				resolveBreadboardSessionTarget({}, undefined, "agent_configs/v2/daily_driver.v1.yaml", root, true),
			).toEqual({
				kind: "create",
				request: {
					configPath: "agent_configs/v2/daily_driver.v1.yaml",
					lockId: "agent_configs/v2/daily_driver.v1.lock.json",
					permissionMode: "configured",
					workspace: root,
				},
			});
		} finally {
			await fsp.rm(root, { recursive: true, force: true });
		}
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
				manager({ schemaVersion: "breadboard.session-binding.v4" }),
				undefined,
				workspace,
				true,
			),
		).toThrow("malformed or incompatible");
	});
});
