import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BREADBOARD_DISTRIBUTION_POLICY } from "../packages/utils/src/product-distribution";
import { buildProductRelease, PRODUCT_TARGET } from "./build-product-release";
import { verifyProductArchive } from "./install-product-release";

const ALLOW_UNSIGNED = Object.freeze({ allowUnsignedDevelopment: true });

async function fixture(root: string): Promise<{
	readonly binaryPath: string;
	readonly nativeAddonPath: string;
}> {
	const binaryPath = join(root, "bb");
	const nativeAddonPath = join(root, "pi_natives.darwin-arm64.node");
	await writeFile(
		binaryPath,
		`#!/bin/sh\nprintf '%s\\n' '${[
			`bb/${BREADBOARD_DISTRIBUTION_POLICY.productVersion}`,
			`omp/${BREADBOARD_DISTRIBUTION_POLICY.ompVersion}`,
		].join(" ")}'\n`,
	);
	await chmod(binaryPath, 0o500);
	await writeFile(nativeAddonPath, Buffer.from("native-addon"));
	await chmod(nativeAddonPath, 0o400);

	return { binaryPath, nativeAddonPath };
}

describe("product release builder", () => {
	test("builds a deterministic Darwin arm64 archive from the current policy", async () => {
		const root = await mkdtemp(join(tmpdir(), "bb-product-build-test-"));
		try {
			const inputs = await fixture(root);
			const licensePath = join(root, "LICENSE");
			const noticesPath = join(root, "THIRD_PARTY_NOTICES.txt");
			await writeFile(licensePath, "license\n");
			await writeFile(noticesPath, "notices\n");
			await chmod(licensePath, 0o400);
			await chmod(noticesPath, 0o400);
			const options = {
				...inputs,
				productVersion: BREADBOARD_DISTRIBUTION_POLICY.productVersion,
				developmentEvidence: true,
				licensePath,
				noticesPath,
			};
			const first = await buildProductRelease({ ...options, outputRoot: join(root, "release-a") });
			const second = await buildProductRelease({ ...options, outputRoot: join(root, "release-b") });
			expect(first.target).toEqual(PRODUCT_TARGET);
			expect(first.legal).toEqual({ posture: "unsigned-development", inputsPresent: true });
			expect(first.archiveSha256).toBe(second.archiveSha256);
			expect(await readFile(first.archivePath)).toEqual(await readFile(second.archivePath));
			expect(first.entries.some(entry => entry.endsWith("/bb"))).toBeTrue();
			expect(first.entries.some(entry => entry.includes("/engine/"))).toBeFalse();
			const verified = await verifyProductArchive(first.archivePath, ALLOW_UNSIGNED);
			expect(verified.productVersion).toBe(BREADBOARD_DISTRIBUTION_POLICY.productVersion);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("rejects a native addon path the installer cannot launch", async () => {
		const root = await mkdtemp(join(tmpdir(), "bb-product-build-test-"));
		try {
			const inputs = await fixture(root);
			const incompatibleAddonPath = join(root, "foo.node");
			await writeFile(incompatibleAddonPath, await readFile(inputs.nativeAddonPath));
			await chmod(incompatibleAddonPath, 0o400);
			await expect(
				buildProductRelease({
					...inputs,
					nativeAddonPath: incompatibleAddonPath,
					outputRoot: join(root, "release"),
					productVersion: BREADBOARD_DISTRIBUTION_POLICY.productVersion,
					developmentEvidence: true,
				}),
			).rejects.toThrow(/native addon path must name pi_natives\.darwin-arm64\.node/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("rejects a product version that is not the current distribution policy", async () => {
		const root = await mkdtemp(join(tmpdir(), "bb-product-build-test-"));
		try {
			const inputs = await fixture(root);
			await expect(
				buildProductRelease({
					...inputs,
					outputRoot: join(root, "release"),
					productVersion: "9.9.9",
					developmentEvidence: true,
				}),
			).rejects.toThrow(/current distribution policy/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
