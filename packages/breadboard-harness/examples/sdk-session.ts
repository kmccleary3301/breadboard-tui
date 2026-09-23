import { NativeRpcTransport } from "../src/sdk/native-rpc";

const binaryPath = Bun.argv[2] ?? Bun.env.BB_BINARY;
if (!binaryPath) throw new Error("usage: bun run packages/breadboard-harness/examples/sdk-session.ts /path/to/bb");

const task = Bun.env.BB_TASK ?? "Use run_shell to run printf SDK-NATIVE-OK, then reply exactly SDK-NATIVE-OK.";
const transport = new NativeRpcTransport({
	binaryPath,
	harness: Bun.env.BB_HARNESS ?? "bb-omp.native",
	cwd: Bun.env.BB_CWD,
	inheritEnv: false,
	env: {
		PI_CODING_AGENT_DIR: Bun.env.PI_CODING_AGENT_DIR ?? "",
		BREADBOARD_CONFIG_DIR: Bun.env.BREADBOARD_CONFIG_DIR ?? "",
		OMP_SKIP_SETUP: Bun.env.OMP_SKIP_SETUP ?? "1",
	},
	approval: {
		kind: "deny",
		reason: "SDK example is headless and does not grant shell approval",
	},
});

const events: string[] = [];
const replyTexts: string[] = [];
let approvalRequests = 0;
let cancelPromise: Promise<void> | undefined;
let cancelIssuedWhileTurn = false;
const eventStream = transport.events();
try {
	const cancelTimer = setTimeout(
		() => {
			cancelIssuedWhileTurn = true;
			cancelPromise = transport.cancel({ reason: "SDK example cancels the running turn" });
		},
		Number(Bun.env.BB_CANCEL_AFTER_MS ?? "4000"),
	);
	const created = await transport.createSession({ task });
	for await (const event of eventStream) {
		events.push(event.kind);
		if (event.kind === "approval.requested") approvalRequests += 1;
		if (event.kind === "assistant_message" && typeof event.payload.text === "string" && event.payload.text)
			replyTexts.push(event.payload.text);
		if (event.kind === "session.completed" || event.kind === "session.failed" || event.kind === "session.canceled")
			break;
	}
	clearTimeout(cancelTimer);
	let cancelExitCode = 0;
	try {
		if (cancelPromise === undefined) await transport.cancel({ reason: "SDK example complete" });
		else await cancelPromise;
	} catch {
		cancelExitCode = 1;
	}
	const transcriptPath = await transport.exportTranscript();
	const result = {
		session: created,
		events,
		replyText: replyTexts.at(-1) ?? null,
		approvalRequests,
		approvalPolicy: "deny",
		cancelIssuedWhileTurn,
		transcriptPath,
		exitCodes: { create: 0, cancel: cancelExitCode, transcript: transcriptPath === undefined ? 1 : 0 },
	};
	const output = JSON.stringify(result, null, 2);
	if (Bun.env.BB_OUTPUT) await Bun.write(Bun.env.BB_OUTPUT, `${output}\n`);
	else console.log(output);
} finally {
	await transport.stop();
}
