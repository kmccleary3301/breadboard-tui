#!/usr/bin/env bun

import { createBreadboardClient } from "@breadboard/sdk";
import { createBreadboardModelRolePort } from "../src/breadboard/model-role-port";
import { createBreadboardProviderAuthPort } from "../src/breadboard/provider-auth-adapter";

const engineUrl = process.env.C03_ENGINE_URL;
if (!engineUrl) throw new Error("C03_ENGINE_URL is required");

const providerId = process.env.C03_PROVIDER_ID ?? "openai";
const accountLabel = process.env.C03_ACCOUNT_LABEL ?? "c03-parity";
const firstKey = process.env.C03_FIRST_KEY ?? "c03-parity-key-rotation-one";
const rotatedKey = process.env.C03_ROTATED_KEY ?? "c03-parity-key-rotation-two";
const modelRoles = {
	schema_version: "bb.model_roles.v1",
	defaults: { role: "main", known_but_unbound_role: "use_default", unknown_role: "error" },
	roles: {
		main: {
			primary: {
				provider_id: providerId,
				model_id: "gpt-5.5",
				model_revision: null,
				endpoint_id: null,
				auth_scheme_id: "api_key",
				account_selector: { mode: "default", pin: "session" },
			},
			fallbacks: [],
			fallback_on: ["provider_unavailable", "rate_limited"],
			reasoning: { mode: "effort", effort: "high" },
			generation: { temperature: 0.2, max_output_tokens: 8192 },
			requires: { tools: true, streaming: true },
			service_tier: "default",
		},
	},
	dispatch: { subagents: {}, lanes: {} },
	policy: { allow_environment_overrides: false, cross_provider_fallback: "forbidden", account_failover: "forbidden" },
};

const client = createBreadboardClient({
	baseUrl: engineUrl,
	authToken: process.env.C03_ENGINE_TOKEN,
});
const auth = createBreadboardProviderAuthPort(client);
const roles = createBreadboardModelRolePort(client);

const first = await auth.putApiKey({ providerId, accountLabel, apiKey: firstKey });
const firstCredentials = await auth.listCredentials(providerId);
const firstLock = await roles.resolveModelRoles({ model_roles: modelRoles });
const rotated = await auth.putApiKey({ providerId, accountLabel, apiKey: rotatedKey });
const rotatedCredentials = await auth.listCredentials(providerId);
const rotatedLock = await roles.resolveModelRoles({ model_roles: modelRoles });

if (first.accountLabel !== rotated.accountLabel) throw new Error("credential account identity changed across rotation");
if (first.credentialRef !== rotated.credentialRef) throw new Error("credential reference changed across rotation");
if (firstLock.lock_hash !== rotatedLock.lock_hash) throw new Error("model-role lock hash changed across rotation");
const firstAccount = firstCredentials.find(row => row.credentialRef === first.credentialRef)?.providerId;
const rotatedAccount = rotatedCredentials.find(row => row.credentialRef === rotated.credentialRef)?.providerId;
if (firstAccount !== providerId || rotatedAccount !== providerId)
	throw new Error("provider status changed across rotation");

await auth.revoke({ credentialRef: rotated.credentialRef, reason: "c03 parity cleanup" });
await auth.logout({ credentialRef: rotated.credentialRef });

const result = {
	providerId,
	accountLabel: rotated.accountLabel,
	credentialRef: rotated.credentialRef,
	firstLockHash: firstLock.lock_hash,
	rotatedLockHash: rotatedLock.lock_hash,
	firstProviderStatus: firstAccount,
	rotatedProviderStatus: rotatedAccount,
	cleanup: "revoke+logout",
};
const output = JSON.stringify(result);
if (output.includes(firstKey) || output.includes(rotatedKey))
	throw new Error("parity output contains credential canary");
console.log(output);
