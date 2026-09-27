export const SESSION_EVIDENCE_SCHEMA_VERSION = "bb.p30.session_evidence.v1";
export const SESSION_EVIDENCE_REDACTION_POLICY_VERSION = "bb.p30.session_evidence.redaction.v1";
export const SESSION_EVIDENCE_BOUNDS = Object.freeze({
	maxDepth: 8,
	maxCollectionEntries: 64,
	maxInspectedNodes: 4096,
	maxFindings: 128,
	maxStringBytes: 4096,
});

export type SensitiveValueCategory =
	| "credential"
	| "header"
	| "url"
	| "path"
	| "alias"
	| "account-id"
	| "body"
	| "event-payload"
	| "malformed-body"
	| "error-serialization"
	| "cycle"
	| "depth-limit"
	| "entry-limit"
	| "string-limit";

export interface SensitiveValueFinding {
	readonly location: string;
	readonly category: SensitiveValueCategory;
}

export interface SensitiveValueDetection {
	readonly policyVersion: typeof SESSION_EVIDENCE_REDACTION_POLICY_VERSION;
	readonly inspectedNodes: number;
	readonly truncated: boolean;
	readonly findings: readonly SensitiveValueFinding[];
}

const utf8ByteLength = (value: string) => new TextEncoder().encode(value).byteLength;
const exceedsStringBound = (value: string) =>
	value.length > SESSION_EVIDENCE_BOUNDS.maxStringBytes ||
	utf8ByteLength(value) > SESSION_EVIDENCE_BOUNDS.maxStringBytes;

const CREDENTIAL_KEY =
	/(?:^|[_-])(api[_-]?key|access[_-]?token|refresh[_-]?token|token|auth(?:orization)?|bearer|cookie|password|passwd|secret|credential|private[_-]?key)(?:$|[_-])/i;
const HEADER_KEY = /^(?:headers?|authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i;
const ACCOUNT_ID_KEY = /(?:^|[_-])(?:account[_-]?id|organization[_-]?id|org[_-]?id)(?:$|[_-])/i;
const ALIAS_KEY = /(?:^|[_-])alias(?:$|[_-])/i;
const BODY_KEY = /^(?:body|raw_body|rawBody|request_body|requestBody|response_body|responseBody)$/;
const EVENT_PAYLOAD_KEY = /^(?:payload|event_payload|eventPayload|raw_event|rawEvent)$/;
const URL_VALUE = /(?:https?|wss?|file):\/\//i;
const SCHEMELESS_URL_VALUE = /\b(?:localhost(?::\d{1,5})?|(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d{1,5})?)(?:\/\S*)?/i;
const PATH_VALUE = /(?:^|[\s"'=(])(?:~\/\S+|[A-Za-z]:[\\/]\S+|\\\\\S+|\/(?!\/)[^\s/]\S*)/;
const CREDENTIAL_VALUE =
	/(?:\bBearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|gho|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/i;
const HEADER_VALUE = /\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*:\s*\S+/i;
const ACCOUNT_ID_VALUE =
	/\b(?:ChatGPT[-_ ]Account[-_ ]Id|account[_ -]?id|organization[_ -]?id|org[_ -]?id)\s*[:=]\s*\S+/i;
const ALIAS_VALUE = /\b(?:account[_ -]?alias|alias)\s*[:=]\s*\S+/i;
const BODY_VALUE = /\b(?:response[_ -]?body|request[_ -]?body|raw[_ -]?body)\s*[:=]/i;
const EVENT_PAYLOAD_VALUE = /\b(?:event[_ -]?payload|raw[_ -]?event)\s*[:=]/i;
const ERROR_VALUE = /(?:^|\s)(?:Error|TypeError|RangeError|ReferenceError|SyntaxError|AggregateError):\s/;
const HEX_TOKEN_VALUE = /(?:^|[^A-Za-z0-9])[A-Fa-f0-9]{48,}(?:$|[^A-Za-z0-9])/;

const categoryForKey = (key: string): SensitiveValueCategory | null => {
	if (HEADER_KEY.test(key)) return "header";
	if (ACCOUNT_ID_KEY.test(key)) return "account-id";
	if (CREDENTIAL_KEY.test(key)) return "credential";
	if (ALIAS_KEY.test(key)) return "alias";
	if (BODY_KEY.test(key)) return "body";
	if (EVENT_PAYLOAD_KEY.test(key)) return "event-payload";
	return null;
};

export const detectSensitiveValues = (value: unknown): SensitiveValueDetection => {
	const findings: SensitiveValueFinding[] = [];
	const active = new WeakSet<object>();
	let inspectedNodes = 0;
	let truncated = false;
	const add = (location: string, category: SensitiveValueCategory) => {
		if (findings.length >= SESSION_EVIDENCE_BOUNDS.maxFindings) {
			truncated = true;
			return;
		}
		findings.push({ location, category });
	};
	const visit = (candidate: unknown, depth: number, location: string) => {
		if (inspectedNodes >= SESSION_EVIDENCE_BOUNDS.maxInspectedNodes) {
			truncated = true;
			return;
		}
		inspectedNodes += 1;
		if (depth > SESSION_EVIDENCE_BOUNDS.maxDepth) {
			truncated = true;
			add(location, "depth-limit");
			return;
		}
		if (typeof candidate === "string") {
			if (exceedsStringBound(candidate)) {
				truncated = true;
				add(location, "string-limit");
				return;
			}
			if (URL_VALUE.test(candidate) || SCHEMELESS_URL_VALUE.test(candidate)) add(location, "url");
			if (PATH_VALUE.test(candidate)) add(location, "path");
			if (CREDENTIAL_VALUE.test(candidate) || HEX_TOKEN_VALUE.test(candidate)) add(location, "credential");
			if (HEADER_VALUE.test(candidate)) add(location, "header");
			if (ACCOUNT_ID_VALUE.test(candidate)) add(location, "account-id");
			if (ALIAS_VALUE.test(candidate)) add(location, "alias");
			if (BODY_VALUE.test(candidate)) add(location, "body");
			if (EVENT_PAYLOAD_VALUE.test(candidate)) add(location, "event-payload");
			if (ERROR_VALUE.test(candidate)) add(location, "error-serialization");
			return;
		}
		if (typeof candidate !== "object" || candidate === null) return;
		if (candidate instanceof Error) {
			add(location, "error-serialization");
			return;
		}
		if (!Array.isArray(candidate)) {
			const prototype = Object.getPrototypeOf(candidate);
			if (prototype !== Object.prototype && prototype !== null) {
				truncated = true;
				add(location, "error-serialization");
				return;
			}
		}
		if (active.has(candidate)) {
			add(location, "cycle");
			return;
		}
		active.add(candidate);
		const entries: [string, unknown][] = [];
		let entryLimitExceeded = false;
		if (Array.isArray(candidate)) {
			entryLimitExceeded = candidate.length > SESSION_EVIDENCE_BOUNDS.maxCollectionEntries;
			const length = Math.min(candidate.length, SESSION_EVIDENCE_BOUNDS.maxCollectionEntries);
			for (let index = 0; index < length; index += 1) entries.push([String(index), candidate[index]]);
		} else {
			const objectCandidate = candidate as Record<string, unknown>;
			for (const key in objectCandidate) {
				if (!Object.prototype.hasOwnProperty.call(objectCandidate, key)) continue;
				if (entries.length >= SESSION_EVIDENCE_BOUNDS.maxCollectionEntries) {
					entryLimitExceeded = true;
					break;
				}
				entries.push([key, objectCandidate[key]]);
			}
			entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
		}
		if (entryLimitExceeded) {
			truncated = true;
			add(location, "entry-limit");
		}
		for (let index = 0; index < entries.length; index += 1) {
			const [key, entry] = entries[index];
			const childLocation = `${location}/${index}`;
			if (!Array.isArray(candidate)) {
				const keyCategory = categoryForKey(key);
				if (keyCategory !== null) {
					add(childLocation, keyCategory);
					if (keyCategory === "body" && typeof entry === "string") {
						if (exceedsStringBound(entry)) {
							truncated = true;
							add(childLocation, "string-limit");
						} else {
							try {
								JSON.parse(entry);
							} catch {
								add(childLocation, "malformed-body");
							}
						}
					}
					continue;
				}
			}
			visit(entry, depth + 1, childLocation);
		}
		active.delete(candidate);
	};
	visit(value, 0, "$");
	return Object.freeze({
		policyVersion: SESSION_EVIDENCE_REDACTION_POLICY_VERSION,
		inspectedNodes,
		truncated,
		findings: Object.freeze(findings.map(finding => Object.freeze(finding))),
	});
};
