#!/usr/bin/env bun

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonRecord = { [key: string]: Json };

function record(value: Json, label: string): JsonRecord {
	if (value === null || Array.isArray(value) || typeof value !== "object") throw new Error(`${label} must be an object`);
	return value;
}
function clone(value: Json): Json {
	return JSON.parse(JSON.stringify(value)) as Json;
}
function arg(name: string): string {
	const index = Bun.argv.indexOf(name);
	const value = index >= 0 ? Bun.argv[index + 1] : undefined;
	if (!value) throw new Error(`missing ${name}`);
	return value;
}
function nestedBody(envelope: JsonRecord): JsonRecord {
	const body = envelope.body;
	if (body !== null && typeof body === "object" && !Array.isArray(body) && body !== null && "json" in body) return record(body.json, "body.json");
	return envelope;
}
function tools(body: JsonRecord): Json[] {
	if (!Array.isArray(body.tools) || body.tools.length < 2) throw new Error("native raw request must contain at least two tools");
	return body.tools;
}
function mutate(source: Json, mutation: string): Json {
	const envelope = record(clone(source), "envelope");
	const body = nestedBody(envelope);
	const nativeTools = tools(body);
	if (mutation === "description") {
		const first = record(nativeTools[0]!, "tools[0]");
		first.description = `${typeof first.description === "string" ? first.description : ""}\nCONTROL DESCRIPTION MUTATION`;
	} else if (mutation === "type-deleted") {
		const tool = record(nativeTools[0]!, "tools[0]");
		if (Object.hasOwn(tool, "type")) delete tool.type;
		else tool.type = "control";
	} else if (mutation === "tools-swapped") {
		[nativeTools[0], nativeTools[1]] = [nativeTools[1]!, nativeTools[0]!];
	} else if (mutation === "strict-deleted") {
		const tool = record(nativeTools[0]!, "tools[0]");
		if (Object.hasOwn(tool, "strict")) delete tool.strict;
		else tool.strict = true;
	} else if (mutation === "message-extra") {
		const key = Array.isArray(body.input) ? "input" : Array.isArray(body.messages) ? "messages" : undefined;
		if (!key) throw new Error("native raw request has no message array");
		const messages = body[key];
		if (!Array.isArray(messages)) throw new Error(`${key} must be an array`);
		messages.push({ role: "user", content: "CONTROL MESSAGE EXTRA" });
	} else if (mutation === "message-content") {
		const key = Array.isArray(body.input) ? "input" : Array.isArray(body.messages) ? "messages" : undefined;
		if (!key) throw new Error("native raw request has no message array");
		const messages = body[key];
		if (!Array.isArray(messages)) throw new Error(`${key} must be an array`);
		const message = messages.find(value => record(value, "message").role !== "developer");
		if (message === undefined) throw new Error("native raw request has no non-developer message");
		const messageRecord = record(message, "message");
		if (typeof messageRecord.content === "string") messageRecord.content = `${messageRecord.content}\nCONTROL MESSAGE CONTENT MUTATION`;
		else messageRecord.content = "CONTROL MESSAGE CONTENT MUTATION";
	} else {
		throw new Error(`unknown mutation ${mutation}`);
	}
	return envelope;
}

const inputRoot = arg("--input-root");
const outputRoot = arg("--output-root");
const packs = ["claude_code", "codex", "opencode", "oh_my_opencode", "pi", "oh_my_pi"] as const;
const mutations = ["description", "type-deleted", "tools-swapped", "strict-deleted", "message-extra", "message-content"] as const;
for (const pack of packs) {
	const input = JSON.parse(await Bun.file(`${inputRoot}/${pack}/native.raw.json`).text()) as Json;
	for (const mutation of mutations) {
		await Bun.write(`${outputRoot}/${pack}.${mutation}.raw.json`, `${JSON.stringify(mutate(input, mutation), null, 2)}\n`);
	}
}
console.log(`generated ${packs.length * mutations.length} controls from final native raw`);
export {};
