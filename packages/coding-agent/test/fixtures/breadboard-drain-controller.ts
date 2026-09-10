import { createLifecycleE4Client } from "@breadboard/sdk/lifecycle";

interface ControllerInput {
	readonly baseUrl: string;
	readonly ownerGeneration: number;
	readonly ownerCredential: string;
	readonly controlRequestId: string;
	readonly registrationId: string;
	readonly requesterRegistrationGeneration: number;
	readonly requesterClientInstanceId: string;
	readonly registrationCredential: string;
	readonly expectedAdmissionEpoch: number;
}

const input = JSON.parse(await Bun.stdin.text()) as ControllerInput;
const client = createLifecycleE4Client({
	baseUrl: input.baseUrl,
	expectedSessionContract: {
		contractId: "p30-e4-session-v1",
		schemaSha256: "sha256:bb9f6867d4e8ffed40fd565848207c08abc32b96beb6473daaa66efbc8071695",
	},
});
const bound = await client.handshake();
const result = await bound.beginControlDrain({
	ownerGeneration: input.ownerGeneration,
	ownerCredential: input.ownerCredential,
	controlRequestId: input.controlRequestId,
	registrationId: input.registrationId,
	requesterRegistrationGeneration: input.requesterRegistrationGeneration,
	requesterClientInstanceId: input.requesterClientInstanceId,
	registrationCredential: input.registrationCredential,
	expectedAdmissionEpoch: input.expectedAdmissionEpoch,
});
process.stdout.write(`${JSON.stringify(result)}\n`);
