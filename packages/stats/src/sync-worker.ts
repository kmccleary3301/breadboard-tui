/**
 * Stateless parse worker for `syncAllSessions`. The main thread owns the
 * SQLite handle; workers receive `{ sessionFile, fromOffset }`, run
 * `parseSessionFile` (which is pure I/O + CPU, no DB), and post the
 * structured-clone-safe result back. One in-flight request per worker so
 * the main thread can fan jobs out 1:1 with the pool size.
 *
 * A `{ kind: "ping" }` request is also accepted and replies with
 * `{ ok: true, kind: "pong" }` — used by `smokeTestSyncWorker` to prove the
 * worker actually spawns and runs in compiled binaries (regression coverage
 * for issue #1011 / PR #1027, where the worker silently failed to load).
 */

import { parentPort } from "node:worker_threads";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import { type ParseSessionResult, parseSessionFile } from "./parser";

export type SyncWorkerRequest = { kind?: "parse"; sessionFile: string; fromOffset: number } | { kind: "ping" };

export type SyncWorkerResponse =
	| { ok: true; kind?: "parse"; result: ParseSessionResult }
	| { ok: true; kind: "pong" }
	| { ok: false; error: string };

if (!parentPort) throw new Error("stats sync worker: missing parentPort");

const port = parentPort;
const handleMessage = async (message: unknown): Promise<void> => {
	const request = message as SyncWorkerRequest;
	try {
		if (request.kind === "ping") {
			port.postMessage({ ok: true, kind: "pong" } satisfies SyncWorkerResponse);
			return;
		}
		const result = await parseSessionFile(request.sessionFile, request.fromOffset);
		port.postMessage({ ok: true, result } satisfies SyncWorkerResponse);
	} catch (err) {
		const error = err instanceof Error ? (err.stack ?? err.message) : String(err);
		port.postMessage({ ok: false, error } satisfies SyncWorkerResponse);
	}
};

const inbox = consumeWorkerInbox();
if (inbox) {
	inbox.bind(message => void handleMessage(message));
} else {
	port.on("message", message => void handleMessage(message));
}
