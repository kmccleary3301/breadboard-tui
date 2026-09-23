import type { CanonicalJson } from "../canonical-json";

export type NativeJsonSchema = Readonly<Record<string, CanonicalJson>>;

export interface NativeToolParameter {
	readonly name: string;
	readonly type: string;
	readonly description?: string;
	readonly required?: boolean;
	readonly default?: CanonicalJson;
	readonly enum?: readonly string[];
	readonly minimum?: number;
	readonly items?: NativeJsonSchema;
	readonly properties?: Readonly<Record<string, NativeJsonSchema>>;
}

export interface NativeToolDefinition {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly aliases: readonly string[];
	readonly parameters: readonly NativeToolParameter[];
	readonly schema: NativeJsonSchema;
	readonly maxPerTurn?: number;
	readonly readonly: boolean;
	readonly blocking: boolean;
}

export interface NativeToolResult {
	readonly text: string;
	readonly details?: CanonicalJson;
	readonly isError?: boolean;
}

export interface NativeToolCallContext {
	readonly cwd: string;
	readonly signal?: AbortSignal;
	readonly runShell?: (command: string, timeoutSeconds: number | undefined, signal?: AbortSignal) => Promise<NativeToolResult>;
	readonly runEval?: (input: Readonly<Record<string, CanonicalJson>>, signal?: AbortSignal) => Promise<NativeToolResult>;
	readonly shutdown: () => void;
}

export interface NativeToolRegistration extends NativeToolDefinition {
	readonly execute: (
		input: Readonly<Record<string, CanonicalJson>>,
		context: NativeToolCallContext,
	) => Promise<NativeToolResult>;
}

export type NativeHookEvent =
	| { readonly type: "before_agent_start"; readonly systemPrompt: readonly string[] }
	| { readonly type: "turn_start" }
	| { readonly type: "turn_end"; readonly toolNames: readonly string[] }
	| { readonly type: "tool_call"; readonly toolName: string }
	| { readonly type: "session_stop" };

export type NativeHookResult =
	| { readonly decision: "block"; readonly reason: string }
	| { readonly continue: true; readonly message: string }
	| void;

export interface NativeExtensionApi {
	readonly registerTool: (tool: NativeToolRegistration) => void;
	readonly on: (event: NativeHookEvent["type"], handler: (event: NativeHookEvent) => NativeHookResult | Promise<NativeHookResult>) => void;
}

export type NativeExtensionFactory = (api: NativeExtensionApi) => void;

export interface LoadedNativeHarness {
	readonly lockPath: string;
	readonly workspaceRoot: string;
	readonly lock: Readonly<Record<string, CanonicalJson>>;
	readonly meta: Readonly<Record<string, CanonicalJson>>;
	readonly graphHash: string;
	readonly systemPrompt: string;
	readonly toolSurface: NativeToolSurfacePack;
	readonly toolNames: readonly string[];
	readonly extensionFactory: NativeExtensionFactory;
	readonly completion: {
		readonly idleTurnLimit?: number;
		readonly noToolTurnsThreshold?: number;
	};
	readonly todos: { readonly enabled: boolean; readonly strict: boolean };
}

export interface NativeToolSurfacePack {
	readonly mode: string;
	readonly tools: readonly NativeToolDefinition[];
	readonly byName: ReadonlyMap<string, NativeToolDefinition>;
}

export interface LoadedNativeLock {
	readonly lockPath: string;
	readonly metaPath: string;
	readonly lock: Readonly<Record<string, CanonicalJson>>;
	readonly meta: Readonly<Record<string, CanonicalJson>>;
	readonly graphHash: string;
}
