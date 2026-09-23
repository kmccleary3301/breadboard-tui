import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	buildSessionTranscript,
	readSessionTranscriptSource,
	sessionTranscriptPath,
	validateSessionTranscript,
	writeSessionTranscript,
} from "../../src/native/session-transcript";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A persisted OMP session with a tool round trip, a user-excluded shell run and an extension custom entry. */
async function recordedSession(): Promise<{ manager: SessionManager; cwd: string; sessionDir: string; file: string }> {
	const cwd = await mkdtemp(join(tmpdir(), "bb-transcript-cwd-"));
	const sessionDir = await mkdtemp(join(tmpdir(), "bb-transcript-sessions-"));
	directories.push(cwd, sessionDir);
	const manager = SessionManager.create(cwd, sessionDir);
	manager.appendMessage({ role: "user", content: "Run echo ok", timestamp: 1 });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1", name: "run_shell", arguments: { command: "echo ok" } }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage,
		stopReason: "toolUse",
		timestamp: 2,
	});
	manager.appendMessage({
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "run_shell",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 3,
	});
	manager.appendMessage({
		role: "bashExecution",
		command: "ls",
		output: "a",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		excludeFromContext: true,
		timestamp: 4,
	});
	manager.appendCustomEntry("tool_execution_start", { toolCallId: "call_1" });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage,
		stopReason: "stop",
		timestamp: 5,
	});
	await manager.flush();
	const file = manager.getSessionFile();
	if (file === undefined) throw new Error("session has no file");
	return { manager, cwd, sessionDir, file };
}

async function transcriptOf(manager: SessionManager) {
	const file = manager.getSessionFile();
	if (file === undefined) throw new Error("session has no file");
	return buildSessionTranscript(await readSessionTranscriptSource(file, manager.getLeafId()), {
		reason: "session_end",
		harness: { specPath: "agent.yaml", graphHash: "abc" },
	});
}

describe("bb.session_transcript.v2 export", () => {
	test("an OMP session exports to a transcript that validates against the bundled closure", async () => {
		const { manager } = await recordedSession();
		const transcript = await transcriptOf(manager);
		expect(validateSessionTranscript(transcript)).toEqual([]);
		expect(transcript.session_id).toBe(manager.getHeader()?.id ?? "");
		expect(transcript.items.map(item => item.kind)).toEqual([
			"user_message",
			"assistant_message",
			"tool_result",
			"bash_execution",
			"custom.tool_execution_start",
			"assistant_message",
		]);
		expect(transcript.items.map(item => item.visibility.model_visible)).toEqual([
			true,
			true,
			true,
			false,
			false,
			true,
		]);
		expect(transcript.items[2]?.call_id).toBe("call_1");
		expect(transcript.items.map(item => item.seq)).toEqual([0, 1, 2, 3, 4, 5]);
		expect(transcript.metadata?.reason).toBe("session_end");
	});

	test("malformed items fail validation, including through the cross-file visibility $ref", async () => {
		const { manager } = await recordedSession();
		const valid = await transcriptOf(manager);
		const broken = JSON.parse(JSON.stringify(valid)) as Record<string, unknown> & {
			items: Record<string, unknown>[];
		};
		const [first, second, third, fourth] = broken.items;
		if (!first || !second || !third || !fourth) throw new Error("expected four items");
		first.kind = "User-Message";
		delete second.visibility;
		third.visibility = { model_visible: "yes", provider_visible: true, host_visible: true };
		fourth.unexpected = 1;
		broken.schema_version = "bb.session_transcript.v1";
		const findings = validateSessionTranscript(broken).map(finding => `${finding.pointer} ${finding.code}`);
		expect(findings).toEqual([
			"/items/0/kind pattern",
			"/items/1/visibility required",
			"/items/2/visibility/model_visible type",
			"/items/3/unexpected additionalProperties",
			"/schema_version const",
		]);
	});

	test("an invalid transcript is refused and nothing is written", async () => {
		const { manager, file } = await recordedSession();
		const transcript = await transcriptOf(manager);
		const [first] = transcript.items;
		if (!first) throw new Error("expected an item");
		first.kind = "";
		await expect(writeSessionTranscript(file, transcript)).rejects.toThrow(
			"bb.session_transcript.v2 export is invalid",
		);
		expect(await Bun.file(sessionTranscriptPath(file)).exists()).toBe(false);
	});

	test("the transcript sits beside the session without changing listing or resume", async () => {
		const { manager, cwd, sessionDir, file } = await recordedSession();
		const before = await readFile(file, "utf8");
		const written = await writeSessionTranscript(file, await transcriptOf(manager));
		expect(written).toBe(sessionTranscriptPath(file));
		expect(JSON.parse(await readFile(written, "utf8"))).toEqual(await transcriptOf(manager));
		// OMP keeps a hidden lock file beside the session; the export leaves no temporary file.
		expect((await readdir(sessionDir)).filter(name => !name.startsWith(".")).sort()).toEqual(
			[basename(file), basename(written)].sort(),
		);

		expect(await readFile(file, "utf8")).toBe(before);
		const listed = await SessionManager.list(cwd, sessionDir);
		expect(listed.map(session => session.path)).toEqual([file]);
		const reopened = await SessionManager.open(file, sessionDir);
		expect(reopened.getBranch().map(entry => entry.id)).toEqual(manager.getBranch().map(entry => entry.id));
		const transcript = await transcriptOf(manager);
		expect(transcript.items.map(item => item.event_id)).toEqual(reopened.getBranch().map(entry => entry.id));
	});

	test("items hold entries as the session file persisted them, not the in-memory copies", async () => {
		const { manager, file } = await recordedSession();
		const huge = "x".repeat(600_000);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "call_2",
			toolName: "run_shell",
			content: [{ type: "text", text: huge }],
			isError: false,
			timestamp: 6,
		});
		await manager.flush();
		const persisted = (await readFile(file, "utf8")).trimEnd().split("\n").at(-1) ?? "";
		const transcript = await transcriptOf(manager);
		expect(transcript.items.at(-1)?.content).toEqual(JSON.parse(persisted));
		expect(JSON.stringify(transcript.items.at(-1)?.content)).not.toContain(huge);
	});
});
