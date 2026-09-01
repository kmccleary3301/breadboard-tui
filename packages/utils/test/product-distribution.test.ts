import { describe, expect, it } from "bun:test";
import { BREADBOARD_DISTRIBUTION_POLICY, formatBreadboardVersion } from "../src/product-distribution";

describe("BreadBoard distribution policy", () => {
	it("freezes the product, SDK, and engine lineage together", () => {
		expect(Object.isFrozen(BREADBOARD_DISTRIBUTION_POLICY)).toBeTrue();
		expect(BREADBOARD_DISTRIBUTION_POLICY).toMatchObject({
			productName: "bb",
			productVersion: "0.1.0-rc.4",
			sdkVersion: "0.4.0",
			engineApiRange: ">=0.4.0 <0.5.0",
		});
	});

	it("formats the frozen lineage for the product version command", () => {
		const expected = [
			`bb/${BREADBOARD_DISTRIBUTION_POLICY.productVersion}`,
			`omp/${BREADBOARD_DISTRIBUTION_POLICY.ompVersion}`,
			`sdk/${BREADBOARD_DISTRIBUTION_POLICY.sdkVersion}`,
			`engine-api ${BREADBOARD_DISTRIBUTION_POLICY.engineApiRange}`,
		].join(" ");
		expect(formatBreadboardVersion()).toBe(expected);
	});
});