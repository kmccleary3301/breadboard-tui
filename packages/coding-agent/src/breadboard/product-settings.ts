import type { SettingDefaultOverrides } from "../config/settings-schema";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { replaceFileAtomically } from "../utils/atomic-file";

export const BREADBOARD_SETTING_DEFAULTS = {
	"statusLine.preset": "bb-balanced",
	"statusLine.separator": "pipe",
	"statusLine.contextLine": "off",
	"statusLine.sessionAccent": false,
	"composer.shape": "box",
	"task.maxConcurrency": 4,
	"task.maxRecursionDepth": 1,
	"task.maxRuntimeMs": 30 * 60_000,
} satisfies SettingDefaultOverrides;

/** Establish BreadBoard identity and defaults before loading the shared CLI. */
export async function activateBreadboardProduct(): Promise<void> {
	process.env.BREADBOARD_PRODUCT = "1";
	const { setDistributionSettingDefaults } = await import("../config/settings-schema");
	setDistributionSettingDefaults(BREADBOARD_SETTING_DEFAULTS);
}

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

export async function writeNativeProfileMigrationReceipt(receiptPath = process.env.BREADBOARD_NATIVE_PROFILE_MIGRATION_RECEIPT): Promise<void> {
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
