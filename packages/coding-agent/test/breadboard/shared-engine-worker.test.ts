import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lifecycleFailure, type LifecycleResult } from "../../src/breadboard/lifecycle/lifecycle-state";
import { parseSharedEngineEvent, SHARED_ENGINE_SCHEMA_VERSION } from "../../src/breadboard/shared-engine-protocol";
import { SharedEngineLeaseServer } from "../../src/breadboard/shared-engine-worker";

const stopped: LifecycleResult = { kind: "stopped", state: { name: "stopped", mode: "local-owned", attempt: 0 } };

async function fixture(closeEngine: () => Promise<LifecycleResult>) {
	const root = await mkdtemp(join(tmpdir(), "bb-shared-"));
	const socket = join(root, "lease.sock");
	const server = new SharedEngineLeaseServer({
		info: {
			schemaVersion: SHARED_ENGINE_SCHEMA_VERSION,
			key: "a".repeat(64),
			endpoint: "http://127.0.0.1:7777",
			engineInstanceId: "engine-instance",
			engineBootId: "engine-boot",
			pid: 123,
			osProcessStartToken: "test:123",
		},
		closeEngine,
		refreshAuth: async () => {},
	});
	const controllers: AbortController[] = [];
	await server.start(socket);
	return {
		server,
		request: (path: string) => fetch(`http://shared-engine.local${path}`, { unix: socket }),
		lease: async () => {
			const controller = new AbortController();
			controllers.push(controller);
			const response = await fetch("http://shared-engine.local/lease", { unix: socket, signal: controller.signal });
			expect(response.status).toBe(200);
			if (!response.body) throw new Error("lease body missing");
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffered = "";
			while (!buffered.includes("\n")) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error("lease ended before ready");
				buffered += decoder.decode(chunk.value, { stream: true });
			}
			expect(parseSharedEngineEvent(JSON.parse(buffered.slice(0, buffered.indexOf("\n"))))).toMatchObject({
				kind: "ready",
			});
			return controller;
		},
		close: async () => {
			for (const controller of controllers) controller.abort();
			server.retire();
			await server.closed;
			await rm(root, { recursive: true, force: true });
		},
	};
}

test("one disconnected window leaves the shared engine available; the final disconnect closes it", async () => {
	const host = await fixture(async () => stopped);
	try {
		const first = await host.lease();
		const second = await host.lease();
		first.abort();
		await Bun.sleep(250);
		const response = await host.request("/info");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ engineInstanceId: "engine-instance" });
		second.abort();
		await host.server.closed;
	} finally {
		await host.close();
	}
});

test("a quiet window retains its engine beyond HTTP idle timeouts", async () => {
	const host = await fixture(async () => stopped);
	try {
		const lease = await host.lease();
		await Bun.sleep(35_000);
		const response = await host.request("/info");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ engineInstanceId: "engine-instance" });
		lease.abort();
		await host.server.closed;
	} finally {
		await host.close();
	}
}, 40_000);

test("a new window is refused while an authenticated shutdown is in flight", async () => {
	const draining = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<LifecycleResult>();
	const host = await fixture(() => {
		draining.resolve();
		return finish.promise;
	});
	try {
		const lease = await host.lease();
		lease.abort();
		await draining.promise;
		const response = await host.request("/lease");
		expect(response.status).toBe(503);
		await response.text();
		finish.resolve(stopped);
		await host.server.closed;
	} finally {
		finish.resolve(stopped);
		await host.close();
	}
});

test("a denied drain keeps the engine reusable and a new lease postpones the retry", async () => {
	let anotherClientActive = true;
	const denied = Promise.withResolvers<void>();
	const host = await fixture(async () => {
		if (!anotherClientActive) return stopped;
		denied.resolve();
		return lifecycleFailure("local-owned", "restart-blocked", "drain_denied");
	});
	try {
		const first = await host.lease();
		first.abort();
		await denied.promise;
		await Bun.sleep(0);
		const second = await host.lease();
		anotherClientActive = false;
		await Bun.sleep(1_100);
		const response = await host.request("/info");
		expect(response.status).toBe(200);
		await response.text();
		second.abort();
		await host.server.closed;
	} finally {
		anotherClientActive = false;
		await host.close();
	}
});
