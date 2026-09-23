import { describe, expect, test } from "bun:test";
import type { RpcCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { NativeRpcTransport, type NativeRpcProcess } from "../../src/sdk/native-rpc";

interface FakePeer {
	process: NativeRpcProcess;
	args: readonly string[];
	writes: string[];
	emit(frame: object): void;
}

function fakePeer(): FakePeer {
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
				if (command.type === "get_state") {
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
							options: ["Approve", "Deny"],
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
		const events = transport.events();
		const created = await transport.createSession({ task: "hello" });
		expect(argv).toEqual(["/tmp/bb", "--mode", "rpc", "--engine-mode", "native", "--harness", "bb-omp.native"]);
		expect(created.session_id).toBe("s1");
		expect((await events.next()).value).toMatchObject({ kind: "session", frame: { type: "agent_start" } });
		expect(await transport.exportTranscript()).toBe("/tmp/bb-transcript.v2.s1.json");
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
});
