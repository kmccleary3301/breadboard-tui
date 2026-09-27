import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { applyUnifiedPatchAdapter, pythonJson } from "../../src/native/adapters";

async function workspace(initial: Record<string, string> = {}): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "bb-native-patch-fallback-"));
	for (const [relativePath, content] of Object.entries(initial)) {
		const target = join(root, relativePath);
		await mkdir(join(target, ".."), { recursive: true });
		await writeFile(target, content, "utf8");
	}
	return root;
}

async function withWorkspace<T>(initial: Record<string, string>, callback: (root: string) => Promise<T>): Promise<T> {
	const root = await workspace(initial);
	try {
		return await callback(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("applyUnifiedPatchAdapter direct fallback", () => {
	test("applies a unified diff adding a file in a non-Git workspace", async () => {
		await withWorkspace({}, async root => {
			const result = await applyUnifiedPatchAdapter(
				root,
				"diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+new\n+file\n",
			);
			const expected = {
				ok: true,
				action: "apply_patch",
				exit: 0,
				stdout: "",
				stderr: "",
				data: { manual_fallback: true, paths: ["new.txt"] },
			};
			expect(result.details).toEqual(expected);
			expect(result.text).toBe(pythonJson(expected));
			expect(result.isError).toBeUndefined();
			expect(await readFile(join(root, "new.txt"), "utf8")).toBe("new\nfile");
		});
	});

	test("applies an OpenCode update hunk in a non-Git workspace", async () => {
		await withWorkspace({ "a.txt": "one\ntwo\nthree\n" }, async root => {
			const patch = "*** Begin Patch\n*** Update File: a.txt\n@@\n one\n-two\n+TWO\n three\n*** End Patch\n";
			const result = await applyUnifiedPatchAdapter(root, patch);
			const expected = {
				ok: true,
				action: "apply_patch",
				exit: 0,
				stdout: "",
				stderr: "",
				data: { manual_fallback: true, paths: ["a.txt"] },
			};
			expect(result.details).toEqual(expected);
			expect(result.text).toBe(pythonJson(expected));
			expect(result.isError).toBeUndefined();
			expect(await readFile(join(root, "a.txt"), "utf8")).toBe("one\nTWO\nthree\n");
		});
	});

	test("reports the Python failure for a non-applying update hunk", async () => {
		await withWorkspace({ "a.txt": "one\ntwo\n" }, async root => {
			const patch = "*** Begin Patch\n*** Update File: a.txt\n@@\n one\n-WRONG\n+TWO\n*** End Patch\n";
			const result = await applyUnifiedPatchAdapter(root, patch);
			const reason = "Failed to apply patch hunk in a.txt: context not found";
			const expected = {
				ok: false,
				action: "apply_patch",
				exit: 1,
				stdout: "",
				stderr: `patch did not apply: ${reason} in a.txt`,
				data: { manual_fallback: true, reason: `${reason} in a.txt` },
			};
			expect(result.details).toEqual(expected);
			expect(result.text).toBe(pythonJson(expected));
			expect(result.isError).toBe(true);
			expect(await readFile(join(root, "a.txt"), "utf8")).toBe("one\ntwo\n");
		});
	});

	test("moves an updated file and removes the source in a non-Git workspace", async () => {
		await withWorkspace({ "old.txt": "old\n" }, async root => {
			const patch = "*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n old\n*** End Patch\n";
			const result = await applyUnifiedPatchAdapter(root, patch);
			const expected = {
				ok: true,
				action: "apply_patch",
				exit: 0,
				stdout: "",
				stderr: "",
				data: { manual_fallback: true, paths: ["new.txt"] },
			};
			expect(result.details).toEqual(expected);
			expect(result.text).toBe(pythonJson(expected));
			expect(await readFile(join(root, "new.txt"), "utf8")).toBe("old\n");
			expect(await Bun.file(join(root, "old.txt")).exists()).toBe(false);
		});
	});
});
