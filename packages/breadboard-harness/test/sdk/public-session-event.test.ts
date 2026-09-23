import { expect, test } from "bun:test";
import { validateBundledSchema } from "../../src/compiler/validate";
import type {
	PublicApprovalRequestedPayload,
	PublicInputAcceptedPayload,
	PublicSessionCompletedPayload,
	PublicSessionEvent,
	PublicSessionStartedPayload,
} from "../../src/sdk/public-session-event";

type IsRequired<T, K extends keyof T> = {} extends Pick<T, K> ? false : true;
type Assert<T extends true> = T;
type Started = Extract<PublicSessionEvent, { kind: "session.started" }>;
type Input = Extract<PublicSessionEvent, { kind: "input.accepted" }>;
type Approval = Extract<PublicSessionEvent, { kind: "approval.requested" }>;
type Completed = Extract<PublicSessionEvent, { kind: "session.completed" }>;
type _StartedHashesAreRequired = Assert<
	IsRequired<Extract<Started["payload"], PublicSessionStartedPayload>, "effective_lock_hash"> extends true
		? IsRequired<Extract<Started["payload"], PublicSessionStartedPayload>, "task_hash">
		: false
>;
type _InputFieldsAreRequired = Assert<
	IsRequired<Extract<Input["payload"], PublicInputAcceptedPayload>, "content_hash"> extends true
		? IsRequired<Extract<Input["payload"], PublicInputAcceptedPayload>, "attachments">
		: false
>;
type _ApprovalFieldsAreRequired = Assert<
	IsRequired<Extract<Approval["payload"], PublicApprovalRequestedPayload>, "request_id"> extends true
		? IsRequired<Extract<Approval["payload"], PublicApprovalRequestedPayload>, "operation">
		: false
>;
type _CompletedFieldsAreRequired = Assert<
	IsRequired<Extract<Completed["payload"], PublicSessionCompletedPayload>, "outcome"> extends true
		? IsRequired<Extract<Completed["payload"], PublicSessionCompletedPayload>, "summary">
		: false
>;

// Keep the compile-time assertions above exercised by the test runner's typecheck.
test("public event payload required-field contract is compiled", () => {
	expect(true).toBe(true);
});

test("public start and cancel request samples validate bundled schemas", () => {
	expect(
		validateBundledSchema("https://breadboard.dev/contracts/public/schemas/bb.session_start_request.v1.schema.json", {
			lock_id: "lock",
			task: "task",
		}),
	).toEqual([]);
	expect(
		validateBundledSchema(
			"https://breadboard.dev/contracts/public/schemas/bb.session_cancel_request.v1.schema.json",
			{
				reason: "operator request",
			},
		),
	).toEqual([]);
});
