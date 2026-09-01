import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
	P30_SESSION_CONTRACT_ID,
	P30_SESSION_SCHEMA_SHA256,
	LifecycleE4ClientError,
	createLifecycleE4Client,
	type LifecycleE4Client,
} from "@breadboard/sdk/lifecycle";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import {
	createDefaultLifecycleProcessAdapter,
	type LifecycleClock,
	type LifecycleSupervisorDependencies,
	LifecycleSupervisor,
	readKeychainReference,
	type ResolvedRemoteSecurity,
} from "./lifecycle-supervisor";
import { LocalAuthorityStore } from "./local-authority-store";
import type { BreadboardAuth, BreadboardRunConfig } from "./run-config";

function productionClock(): LifecycleClock {
	return { now: Date.now, sleep: milliseconds => Bun.sleep(milliseconds) };
}

function productionCredential(): string {
	return randomBytes(32).toString("base64url");
}

function productionOwnerCredential(): Buffer {
	const source = randomBytes(32);
	const encoded = Buffer.allocUnsafe(source.byteLength * 2);
	const hex = "0123456789abcdef";
	try {
		for (let index = 0; index < source.byteLength; index += 1) {
			const byte = source[index] as number;
			encoded[index * 2] = hex.charCodeAt(byte >>> 4);
			encoded[index * 2 + 1] = hex.charCodeAt(byte & 0x0f);
		}
		return encoded;
	} finally {
		source.fill(0);
	}
}

async function productionRemoteSecurity(
	auth: Exclude<BreadboardAuth, { readonly kind: "process-secret" }>,
): Promise<ResolvedRemoteSecurity> {
	const resolved = await readKeychainReference(auth.reference);
	if (auth.kind === "keychain-reference") return { bearerToken: resolved };
	try {
		const parsed: unknown = JSON.parse(resolved);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			!("certificatePem" in parsed) ||
			!("privateKeyPem" in parsed)
		)
			throw new Error("invalid identity");
		const identity = parsed as { certificatePem?: unknown; privateKeyPem?: unknown };
		if (typeof identity.certificatePem !== "string" || typeof identity.privateKeyPem !== "string")
			throw new Error("invalid identity");
		return { certificatePem: identity.certificatePem, privateKeyPem: identity.privateKeyPem };
	} catch {
		throw new LifecycleE4ClientError({ kind: "tls", code: "tls_transport_error" });
	}
}

function productionClient(config: {
	readonly baseUrl: string;
	readonly timeoutMs: number;
	readonly bearerToken?: string;
	readonly fetch?: typeof fetch;
}): LifecycleE4Client {
	return createLifecycleE4Client({
		baseUrl: config.baseUrl,
		timeoutMs: config.timeoutMs,
		expectedSessionContract: {
			contractId: P30_SESSION_CONTRACT_ID,
			schemaSha256: P30_SESSION_SCHEMA_SHA256,
		},
		...(config.bearerToken === undefined ? {} : { bearerToken: config.bearerToken }),
		...(config.fetch === undefined ? {} : { fetch: config.fetch }),
	});
}

export function createProductionLifecycleSupervisor(
	config: BreadboardRunConfig,
	stateChanged: NonNullable<LifecycleSupervisorDependencies["stateChanged"]>,
): LifecycleSupervisor {
	const dependencies = {
		clock: productionClock(),
		randomCredential: productionCredential,
		randomSecret: () => randomBytes(32),
		randomOwnerCredential: productionOwnerCredential,
		createClient: productionClient,
		resolveRemoteSecurity: productionRemoteSecurity,
		stateChanged,
		restartOnUnexpectedChildExit: false,
	};
	if (config.mode !== "local-owned") return new LifecycleSupervisor(config, dependencies);
	const endpoint = config.endpoint;
	if (!endpoint) throw new Error("local-owned requires one endpoint");
	const store = new LocalAuthorityStore(join(getAgentDir(), "breadboard", "lifecycle"));
	const stateRootRelativePath = join("engine-state", LocalAuthorityStore.endpointKey(endpoint));
	return new LifecycleSupervisor(config, {
		...dependencies,
		store,
		process: createDefaultLifecycleProcessAdapter(
			{
				stateRootPath: join(store.root, stateRootRelativePath),
				ensure: relativePath =>
					store.ensurePrivateDirectory(
						relativePath === undefined ? stateRootRelativePath : join(stateRootRelativePath, relativePath),
					),
			},
			config.installedEngineIdentity !== undefined,
		),
	});
}