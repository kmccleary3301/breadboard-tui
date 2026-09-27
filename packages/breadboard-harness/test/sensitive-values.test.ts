import { describe, expect, test } from "bun:test";
import { detectSensitiveValues } from "../src/sensitive-values";

describe("detectSensitiveValues", () => {
	test("detects URLs, paths, credentials, and sensitive keys", () => {
		const result = detectSensitiveValues({
			endpoint: "https://example.com/api",
			filePath: "/etc/passwd",
			token: "sk-1234567890abcdef1234567890",
			clean: "hello world",
		});
		expect(result.findings.length).toBeGreaterThan(0);
		const categories = result.findings.map(f => f.category);
		expect(categories).toContain("credential");
	});

	test("passes clean values without findings", () => {
		const result = detectSensitiveValues("clean ordinary text without any secrets or paths");
		expect(result.findings).toHaveLength(0);
		expect(result.truncated).toBe(false);
	});
});
