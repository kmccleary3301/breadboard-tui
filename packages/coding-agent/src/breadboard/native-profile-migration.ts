import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { registerGlobalSettingsMigration } from "../config/settings-extensions";
import { replaceFileAtomically } from "../utils/atomic-file";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Apply or recognize the one-shot R39-to-native rewrite to a global profile. */
export function migrateNativeProfile(raw: Record<string, unknown>): boolean {
	if (process.env.BREADBOARD_PRODUCT !== "1" || !isRecord(raw.breadboard)) return false;
	const breadboard = raw.breadboard;
	const harness = isRecord(breadboard.harness) ? breadboard.harness : undefined;
	const defaultHarness = harness?.default;
	const legacyKeys = [
		"engineMode",
		"baseUrl",
		"auth",
		"tls",
		"engineArtifact",
		"ownerExitPolicy",
		"sessionConfigPath",
	];
	const isNativeProfile = defaultHarness === "daily_driver" && !legacyKeys.some(key => key in breadboard);
	if (isNativeProfile) return true;
	const isR39Harness = typeof defaultHarness === "string" && /(?:^|[/\\])r39(?:[/\\])/.test(defaultHarness);
	if (harness === undefined || !isR39Harness || breadboard.engineMode !== "local-owned") return false;
	for (const key of legacyKeys) {
		delete breadboard[key];
	}
	harness.default = "daily_driver";
	return true;
}

export async function writeNativeProfileMigrationReceipt(
	receiptPath = process.env.BREADBOARD_NATIVE_PROFILE_MIGRATION_RECEIPT,
): Promise<void> {
	if (!receiptPath) return;
	const temporaryPath = `${receiptPath}.${process.pid}.${randomUUID()}.tmp`;
	await fs.promises.mkdir(path.dirname(receiptPath), { recursive: true });
	try {
		await fs.promises.writeFile(
			temporaryPath,
			`${JSON.stringify({ schema: "bb.native_profile_migration.receipt.v1" })}\n`,
			{ mode: 0o600 },
		);
		await replaceFileAtomically(temporaryPath, receiptPath);
	} finally {
		await fs.promises.unlink(temporaryPath).catch(() => {});
	}
}

/** Register the one-shot profile rewrite the launcher requests; returns a handle that removes it. */
export function registerNativeProfileMigration(): () => void {
	return registerGlobalSettingsMigration({
		apply: migrateNativeProfile,
		afterWrite: () => writeNativeProfileMigrationReceipt(),
	});
}
