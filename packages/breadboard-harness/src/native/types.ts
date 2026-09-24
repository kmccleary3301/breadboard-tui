import type { CanonicalJson, JsonRecord } from "../canonical-json";

/** One vendored tool definition, rendered the way the Python reference offers it to a provider. */
export interface NativeToolDefinition {
	readonly id: string;
	/** Source definition file path used for Python's codepoint registry ordering. */
	readonly sourcePath?: string;
	readonly name: string;
	readonly description: string;
	/** JSON Schema object for the provider's function `parameters`. */
	readonly parameters: JsonRecord;
	readonly strict?: boolean;
	/** `provider_routing.openai.native_primary`: offered through provider function calling. */
	readonly nativePrimary: boolean;
	/** `execution.max_per_turn`. */
	readonly maxPerTurn?: number;
}

export interface NativeToolSurfacePack {
	readonly mode: string;
	/** Enabled tools sent as provider function tools, in the reference's registry order. */
	readonly native: readonly NativeToolDefinition[];
	/** Enabled tools the reference offers only through its text-call dialect. */
	readonly textInvoked: readonly NativeToolDefinition[];
}

/** A model-facing tool result: the text the model reads plus structured details for the host. */
export interface NativeToolResult {
	readonly text: string;
	readonly details?: CanonicalJson;
	readonly isError?: boolean;
}

export interface LoadedNativeLock {
	readonly lockPath: string;
	readonly metaPath: string;
	readonly lock: JsonRecord;
	readonly meta: JsonRecord;
	readonly graphHash: string;
}
