import { createLifecycleE4Client } from "@breadboard/sdk/internal";

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
		schemaSha256: "sha256:385c19de8557a958b10d4a78afc64014a200558b8f089295882a1d9eb4b5d55a",
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
