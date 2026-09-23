import { describe, expect, test } from "bun:test";
import { validateBundledSchema } from "../../src/compiler/validate";
import type { PublicSessionEvent } from "../../src/sdk/public-session-event";
import type { RpcCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { NativeRpcTransport, type NativeRpcProcess } from "../../src/sdk/native-rpc";

interface FakePeer {
	process: NativeRpcProcess;
	args: readonly string[];
	writes: string[];
	emit(frame: object): void;
}

function fakePeer(approvalOptions: readonly string[] = ["Approve", "Deny"]): FakePeer {
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let exit: (() => void) | undefined;
	const writes: string[] = [];
	const encoder = new TextEncoder();
	const emit = (frame: object): void => controller?.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
	const process: NativeRpcProcess = {
		stdin: {
			write(data) {
				const line = typeof data === "string" ? data : new TextDecoder().decode(data);
				writes.push(line.trim());
				const command = JSON.parse(line) as RpcCommand;
				if (command.type === "negotiate_protocol") {
					emit({
						type: "response",
						id: command.id,
						command: "negotiate_protocol",
						success: true,
						data: { protocolVersion: 2 },
					});
				} else if (command.type === "get_state") {
					emit({
						type: "response",
						id: command.id,
						command: "get_state",
						success: true,
						data: { sessionId: "s1", sessionFile: "/tmp/s1.jsonl", isStreaming: false },
					});
				} else if (command.type === "prompt") {
					if (command.message === "ask")
						emit({
							type: "extension_ui_request",
							id: "approval-1",
							method: "select",
							title: "Allow tool: bash",
							options: approvalOptions,
						});
					if (command.message === "/bb-transcript")
						emit({
							type: "extension_ui_request",
							id: "notice-1",
							method: "notify",
							message: "Transcript written to /tmp/bb-transcript.v2.s1.json",
						});
					emit({
						type: "response",
						id: command.id,
						command: "prompt",
						success: true,
						data: { agentInvoked: true },
					});
					emit({ type: "agent_start" });
				} else if (command.type === "abort") {
					emit({ type: "response", id: command.id, command: "abort", success: true });
				} else if (command.type === "switch_session") {
					emit({
						type: "response",
						id: command.id,
						command: "switch_session",
						success: true,
						data: { cancelled: false },
					});
				} else if (command.type === "new_session") {
					emit({
						type: "response",
						id: command.id,
						command: "new_session",
						success: true,
						data: { cancelled: false },
					});
				}
			},
		},
		stdout: new ReadableStream({
			start(next) {
				controller = next;
			},
		}),
		exited: new Promise(resolve => {
			exit = () => resolve(0);
		}),
		kill() {
			exit?.();
			controller?.close();
		},
	};
	queueMicrotask(() => emit({ type: "ready", protocolVersion: 1 }));
	return { process, args: [], writes, emit };
}

async function eventually<T>(read: () => T | undefined): Promise<T> {
	for (let index = 0; index < 20; index += 1) {
		const value = read();
		if (value !== undefined) return value;
		await Bun.sleep(1);
	}
	throw new Error("timed out waiting for fake RPC frame");
}

describe("NativeRpcTransport", () => {
	test("selects a built-in harness, creates a session, streams events, and exports transcript", async () => {
		const peer = fakePeer();
		let argv: readonly string[] = [];
		const transport = new NativeRpcTransport({
			binaryPath: "/tmp/bb",
			harness: "bb-omp.native",
			spawn: async args => {
				argv = args;
				return peer.process;
			},
		});
		const events = transport.rawEvents();
		const created = await transport.createSession({ task: "hello" });
		expect(argv).toEqual(["/tmp/bb", "--mode", "rpc", "--engine-mode", "native", "--harness", "bb-omp.native"]);
		expect(created.session_id).toBe("s1");
		expect((await events.next()).value).toMatchObject({ kind: "session", frame: { type: "agent_start" } });
		expect(await transport.exportTranscript()).toBe("/tmp/bb-transcript.v2.s1.json");
		await transport.stop();
	});

	test("projects approval and cancellation frames as schema-valid public events", async () => {
		const peer = fakePeer();
		const transport = new NativeRpcTransport({ binaryPath: "/tmp/bb", spawn: async () => peer.process });
		const events = transport.events();
		await transport.createSession({ task: "hello" });
		await transport.prompt("ask");
		await eventually(() => peer.writes.find(line => line.includes("approval-1")));
		await transport.cancel({ reason: "test cancellation" });
		const projected: PublicSessionEvent[] = [];
		for (let index = 0; index < 6; index += 1) projected.push((await events.next()).value as PublicSessionEvent);
		expect(projected.map(event => event.kind)).toEqual([
			"session.started",
			"input.accepted",
			"approval.requested",
			"approval.resolved",
			"input.accepted",
			"session.canceled",
		]);
		for (const event of projected) {
			expect(
				validateBundledSchema(
					"https://breadboard.dev/contracts/public/schemas/bb.public_session_event.v1.schema.json",
					event,
				),
			).toEqual([]);
		}
		await transport.stop();
	});

	test("forwards approval and fail-closed denial as typed RPC responses", async () => {
		const approved = fakePeer();
		const allow = new NativeRpcTransport({
			binaryPath: "/tmp/bb",
			approval: {
				kind: "forward",

				decide: async request =>
					request.options?.includes("Approve") ? { decision: "allow" } : { decision: "deny" },
			},
			spawn: async () => approved.process,
		});
		await allow.start();
		await allow.prompt("ask");
		await eventually(() => approved.writes.find(line => line.includes("approval-1")));
		expect(approved.writes.at(-1)).toContain('"value":"Approve"');
		await allow.stop();

		const denied = fakePeer();
		const deny = new NativeRpcTransport({ binaryPath: "/tmp/bb", spawn: async () => denied.process });
		await deny.start();
		await deny.prompt("ask");
		await eventually(() => denied.writes.find(line => line.includes("approval-1")));
		expect(denied.writes.at(-1)).toContain('"value":"Deny"');
		await deny.stop();
	});
	test("projects assistant and tool frames with schema-valid payloads", async () => {
		const peer = fakePeer();
		const transport = new NativeRpcTransport({ binaryPath: "/tmp/bb", spawn: async () => peer.process });
		const events = transport.events();
		await transport.createSession({ task: "hello" });
		peer.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "true" } });
		peer.emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: "ok", isError: false });
		peer.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
		peer.emit({ type: "agent_end" });
		const projected: PublicSessionEvent[] = [];
		for (let index = 0; index < 6; index += 1) projected.push((await events.next()).value as PublicSessionEvent);
		expect(projected.map(event => event.kind)).toEqual([
			"session.started",
			"input.accepted",
			"tool_call",
			"tool_result",
			"assistant_message",
			"session.completed",
		]);
		for (const event of projected) {
			expect(
				validateBundledSchema(
					"https://breadboard.dev/contracts/public/schemas/bb.public_session_event.v1.schema.json",
					event,
				),
			).toEqual([]);
		}
		await transport.stop();
	});

	test("matches exact approval labels and cancels unknown select options", async () => {
		const reversed = fakePeer(["Deny", "Approve"]);
		const allow = new NativeRpcTransport({
			binaryPath: "/tmp/bb",
			approval: { kind: "forward", decide: () => ({ decision: "allow" }) },
			spawn: async () => reversed.process,
		});

		await allow.start();
		await allow.prompt("ask");
		await eventually(() => reversed.writes.find(line => line.includes("approval-1")));
		expect(reversed.writes.at(-1)).toContain('"value":"Approve"');
		await allow.stop();

		const unknown = fakePeer(["Yes", "No"]);
		const deny = new NativeRpcTransport({ binaryPath: "/tmp/bb", spawn: async () => unknown.process });
		await deny.start();
		await deny.prompt("ask");
		await eventually(() => unknown.writes.find(line => line.includes("approval-1")));
		expect(unknown.writes.at(-1)).toContain('"cancelled":true');
		await deny.stop();
	});
	test("resets or continues public sequence state across resume", async () => {
		const peer = fakePeer();
		const transport = new NativeRpcTransport({ binaryPath: "/tmp/bb", spawn: async () => peer.process });
		const events = transport.events();
		await transport.createSession({ task: "hello" });
		await events.next();
		await events.next();
		peer.emit({ type: "agent_end" });
		const completed = (await events.next()).value as PublicSessionEvent;
		expect(completed).toMatchObject({ kind: "session.completed", seq: 2, session_id: "s1" });
		await transport.resumeSession("/tmp/existing.jsonl");
		const resumed = (await events.next()).value as PublicSessionEvent;
		expect(resumed).toMatchObject({ kind: "session.resumed", seq: 3, session_id: "s1" });
		await transport.prompt("again");
		const accepted = (await events.next()).value as PublicSessionEvent;
		expect(accepted).toMatchObject({ kind: "input.accepted", seq: 4, session_id: "s1" });
		for (const event of [completed, resumed, accepted])
			expect(
				validateBundledSchema(
					"https://breadboard.dev/contracts/public/schemas/bb.public_session_event.v1.schema.json",
					event,
				),
			).toEqual([]);
		await transport.stop();
	});
	test("resumes an existing session from the startup session file and supports cancellation", async () => {
		const peer = fakePeer();
		let argv: readonly string[] = [];
		const transport = new NativeRpcTransport({
			binaryPath: "/tmp/bb",
			resumeSession: "/tmp/existing.jsonl",
			spawn: async args => {
				argv = args;
				return peer.process;
			},
		});
		const resumed = await transport.resumeSession("/tmp/existing.jsonl");
		expect(resumed.session_id).toBe("s1");
		expect(argv).toContain("--resume");
		expect(argv).toContain("/tmp/existing.jsonl");
		await transport.cancel({ reason: "caller stopped" });
		expect(peer.writes.some(line => line.includes('"abort"'))).toBe(true);
		await transport.stop();
	});
	test("cancels unsupported UI methods instead of leaving RPC pending", async () => {
		const peer = fakePeer();
		const transport = new NativeRpcTransport({ binaryPath: "/tmp/bb", spawn: async () => peer.process });
		await transport.start();
		peer.emit({ type: "extension_ui_request", id: "editor-1", method: "editor", title: "Edit" });
		await eventually(() => peer.writes.find(line => line.includes("editor-1")));
		expect(peer.writes.at(-1)).toContain('"cancelled":true');
		await transport.stop();
	});
	test("rejects startup when the child ends before ready", async () => {
		let resolveExit: (() => void) | undefined;
		const process: NativeRpcProcess = {
			stdin: { write() {} },
			stdout: new ReadableStream({
				start(controller) {
					controller.close();
				},
			}),
			exited: new Promise(resolve => {
				resolveExit = () => resolve(1);
			}),
			kill() {
				resolveExit?.();
			},
		};
		const transport = new NativeRpcTransport({ binaryPath: "/tmp/bb", spawn: async () => process });
		await expect(transport.start()).rejects.toThrow("output ended");
	});
});
