import type { EngineDistributionTrustRoot } from "./installed-engine-manifest";
import {
	compiledInstalledEngineTrustRoot,
	type InstalledEngineSelection,
	resolveInstalledEngineSelection,
} from "./installed-engine-selection";
import {
	type BreadboardRunConfig,
	BreadboardRunConfigError,
	hasExplicitEngineSelection,
	type ResolveBreadboardRunConfigInput,
	resolveBreadboardRunConfig,
} from "./run-config";

export interface ResolveProductBreadboardRunConfigInput extends ResolveBreadboardRunConfigInput {
	readonly isBreadboardProduct: boolean;
	readonly productExecutablePath?: string;
	readonly installedTrustRoot?: EngineDistributionTrustRoot;
	readonly resolveInstalledSelection?: (input: {
		readonly productExecutablePath: string;
		readonly trustRoot: EngineDistributionTrustRoot | undefined;
	}) => Promise<InstalledEngineSelection>;
}

export async function resolveProductBreadboardRunConfig(
	input: ResolveProductBreadboardRunConfigInput,
): Promise<BreadboardRunConfig> {
	const effectiveInput: ResolveProductBreadboardRunConfigInput = input.isBreadboardProduct
		? { ...input, environment: { ...(input.environment ?? process.env), BREADBOARD_PRODUCT: "1" } }
		: input;
	try {
		return resolveBreadboardRunConfig(effectiveInput);
	} catch (error) {
		if (
			!input.isBreadboardProduct ||
			!(error instanceof BreadboardRunConfigError) ||
			error.code !== "missing_engine_artifact" ||
			hasExplicitEngineSelection(effectiveInput)
		) {
			throw error;
		}
	}
	const resolveSelection = input.resolveInstalledSelection ?? resolveInstalledEngineSelection;
	const selection = await resolveSelection({
		productExecutablePath: input.productExecutablePath ?? process.execPath,
		trustRoot: input.installedTrustRoot ?? compiledInstalledEngineTrustRoot(),
	});
	return resolveBreadboardRunConfig({
		...effectiveInput,
		installedEngineArtifact: selection.artifact,
		installedEngineIdentity: selection.identity,
	});
}
