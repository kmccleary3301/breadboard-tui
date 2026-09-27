import { version } from "../package.json" with { type: "json" };

export interface BreadboardDistributionPolicy {
	readonly productName: "bb";
	readonly productVersion: string;
	readonly ompVersion: string;
}

/** Frozen product/SDK/engine-interface lineage for a BreadBoard distribution. */
export const BREADBOARD_DISTRIBUTION_POLICY = Object.freeze({
	productName: "bb",
	productVersion: "0.1.0-rc.7",
	ompVersion: version,
}) satisfies BreadboardDistributionPolicy;

/** Render the stable human-readable BreadBoard distribution lineage. */
export function formatBreadboardVersion(): string {
	const policy = BREADBOARD_DISTRIBUTION_POLICY;
	return [`${policy.productName}/${policy.productVersion}`, `omp/${policy.ompVersion}`].join(" ");
}
