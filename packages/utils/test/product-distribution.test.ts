import { describe, expect, it } from "bun:test";
import { BREADBOARD_DISTRIBUTION_POLICY, formatBreadboardVersion } from "../src/product-distribution";

describe("BreadBoard distribution policy", () => {
	it("freezes the product lineage", () => {
		expect(Object.isFrozen(BREADBOARD_DISTRIBUTION_POLICY)).toBeTrue();
		expect(BREADBOARD_DISTRIBUTION_POLICY).toMatchObject({
			productName: "bb",
			productVersion: "0.1.0-rc.7",
		});
	});

	it("formats the frozen lineage for the product version command", () => {
		const expected = [
			`bb/${BREADBOARD_DISTRIBUTION_POLICY.productVersion}`,
			`omp/${BREADBOARD_DISTRIBUTION_POLICY.ompVersion}`,
		].join(" ");
		expect(formatBreadboardVersion()).toBe(expected);
	});
});
