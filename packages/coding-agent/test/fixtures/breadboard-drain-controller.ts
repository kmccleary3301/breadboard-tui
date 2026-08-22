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
		schemaSha256: "sha256:4c796e33684136cd7304c989318ec7ea2735c3702b15de9067a687dcc5310813",
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
