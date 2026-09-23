import { NativeRpcTransport } from "../src/sdk/native-rpc";

const binaryPath = Bun.argv[2] ?? Bun.env.BB_BINARY;
if (!binaryPath) throw new Error("usage: bun run packages/breadboard-harness/examples/sdk-session.ts /path/to/bb");

const task = Bun.env.BB_TASK ?? "Reply with one short sentence confirming the native harness is running.";
const transport = new NativeRpcTransport({
	binaryPath,
	harness: Bun.env.BB_HARNESS ?? "bb-omp.native",
	cwd: Bun.env.BB_CWD,
	env: {
		PI_CODING_AGENT_DIR: Bun.env.PI_CODING_AGENT_DIR ?? "",
		BREADBOARD_CONFIG_DIR: Bun.env.BREADBOARD_CONFIG_DIR ?? "",
		BREADBOARD_OMP_AGENT_DIR: Bun.env.BREADBOARD_OMP_AGENT_DIR ?? "",
		OMP_SKIP_SETUP: Bun.env.OMP_SKIP_SETUP ?? "1",
	},
	approval: {
		kind: "deny",
		reason: "SDK example is headless and does not grant shell approval",
	},
});

const events: string[] = [];
const eventStream = transport.events();
try {
	const created = await transport.createSession({ task });
	for await (const event of eventStream) {
		events.push(event.kind);
		if (event.kind === "session" && event.frame.type === "agent_end") break;
	}
	const transcriptPath = await transport.exportTranscript();
	console.log(JSON.stringify({ session: created, events, transcriptPath }, null, 2));
} finally {
	await transport.stop();
}
