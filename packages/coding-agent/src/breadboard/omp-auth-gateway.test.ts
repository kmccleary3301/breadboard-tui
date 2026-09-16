import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AuthStorage } from "../session/auth-storage";
import { resolveBreadboardOmpAgentDir, startBreadboardOmpGateway } from "./omp-auth-gateway";

const roots: string[] = [];
const storages: AuthStorage[] = [];

async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "breadboard-omp-gateway-test-"));
	roots.push(root);
	return root;
}

async function gatewayFixture() {
	const root = await temporaryRoot();
	const storage = await AuthStorage.create(join(root, "auth.db"));
	storages.push(storage);
	const codex = getBundledModel("openai-codex", "gpt-5.5");
	const openai = getBundledModel("openai", "gpt-5.5");
	if (!codex || !openai) throw new Error("expected bundled Codex and OpenAI test models");
	const available = [codex, openai];
	const gateway = startBreadboardOmpGateway(storage, { getAvailable: () => available });
	return { gateway, available };
}

afterEach(async () => {
	for (const storage of storages.splice(0)) storage.close();
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("BreadBoard OMP auth gateway", () => {
	test("requires its bearer and advertises only available provider-qualified models", async () => {
		const { gateway } = await gatewayFixture();
		try {
			const unauthorized = await fetch(`${gateway.binding.url}/v1/models`);
			expect(unauthorized.status).toBe(401);
			const wrongToken = await fetch(`${gateway.binding.url}/v1/models`, {
				headers: { Authorization: "Bearer not-the-gateway-token" },
			});
			expect(wrongToken.status).toBe(401);

			const response = await fetch(`${gateway.binding.url}/v1/models`, {
				headers: { Authorization: `Bearer ${gateway.binding.token}` },
			});
			expect(response.status).toBe(200);
			const body = (await response.json()) as { object: string; data: Array<{ id: string }> };
			expect(body.object).toBe("list");
			expect(body.data.map(model => model.id)).toEqual(["openai-codex/gpt-5.5", "openai/gpt-5.5"]);
			expect(body.data.map(model => model.id)).not.toContain("gpt-5.5");
		} finally {
			await gateway.close();
		}
	});

	test("rejects an ambiguous bare model id before provider inference", async () => {
		const { gateway } = await gatewayFixture();
		try {
			const response = await fetch(`${gateway.binding.url}/v1/responses`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${gateway.binding.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ model: "gpt-5.5" }),
			});
			expect(response.status).toBe(404);
			expect(await response.json()).toMatchObject({ error: { type: "invalid_request_error" } });
		} finally {
			await gateway.close();
		}
	});

	test("makes the loopback listener unreachable after close", async () => {
		const { gateway } = await gatewayFixture();
		try {
			const url = `${gateway.binding.url}/v1/models`;
			const headers = { Authorization: `Bearer ${gateway.binding.token}` };
			expect((await fetch(url, { headers })).status).toBe(200);
			await gateway.close();
			await expect(fetch(url, { headers })).rejects.toThrow();
		} finally {
			await gateway.close();
		}
	});
});

describe("resolveBreadboardOmpAgentDir", () => {
	test("returns undefined when gateway agent sharing is disabled", () => {
		expect(resolveBreadboardOmpAgentDir(undefined)).toBeUndefined();
	});

	test("rejects blank and missing paths without creating credentials", async () => {
		const root = await temporaryRoot();
		const before = await readdir(root);
		expect(() => resolveBreadboardOmpAgentDir("   ")).toThrow();
		expect(() => resolveBreadboardOmpAgentDir(join(root, "missing-agent-dir"))).toThrow();
		expect(await readdir(root)).toEqual(before);
	});

	test("rejects a non-directory path without replacing it or creating credentials", async () => {
		const root = await temporaryRoot();
		const file = join(root, "not-a-directory");
		await writeFile(file, "fixture");
		const before = await readdir(root);
		expect(() => resolveBreadboardOmpAgentDir(file)).toThrow();
		expect(await readdir(root)).toEqual(before);
		expect((await stat(file)).isFile()).toBe(true);
	});

	test("rejects a directory without a regular agent.db without creating credentials", async () => {
		const root = await temporaryRoot();
		const dir = join(root, "missing-agent-db");
		await mkdir(dir);
		const before = await readdir(dir);
		expect(() => resolveBreadboardOmpAgentDir(dir)).toThrow();
		expect(await readdir(dir)).toEqual(before);
	});

	test("resolves a valid original directory to its canonical path", async () => {
		const root = await temporaryRoot();
		const original = join(root, "original");
		const alias = join(root, "alias");
		await mkdir(original);
		await writeFile(join(original, "agent.db"), "fixture");
		await symlink(original, alias, "dir");
		expect(resolveBreadboardOmpAgentDir(alias)).toBe(await realpath(original));
	});
});
