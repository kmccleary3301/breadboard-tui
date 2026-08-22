import { matchesKey, padding, visibleWidth } from "@oh-my-pi/pi-tui";
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { IrcBus, IrcHistoryRecord, IrcReadCursor } from "../../../irc/bus";
import { deriveIrcConversations, type IrcConversation } from "../../../irc/conversations";
import { type AgentRegistry, MAIN_AGENT_ID } from "../../../registry/agent-registry";
import { truncateToWidth } from "../../../tools/render-utils";
import { theme } from "../../theme/theme";
import { matchesSelectDown, matchesSelectUp } from "../../utils/keybinding-matchers";
import { sanitizeDisplayText, sanitizeLine } from "../agent-hub-renderer";
import { bottomBorder, divider, row, topBorder } from "../overlay-box";

function activityClock(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
}

export interface AgentHubRemoteTranscript {
	text: string;
	newSize: number;
	error?: string;
}

export interface AgentHubRemote {
	chat(id: string, text: string): void;
	kill(id: string): void;
	revive(id: string): void;
	readMessages?(): Promise<IrcHistoryRecord[] | null>;
	sendMessage?(to: string, body: string, replyTo?: string): Promise<string | undefined>;
	readTranscript(id: string, fromByte: number): Promise<AgentHubRemoteTranscript | null>;
}

export interface AgentHubMessagesViewDeps {
	registry: AgentRegistry;
	irc: IrcBus;
	remote?: AgentHubRemote;
	renderTabs: () => string;
	requestRender: () => void;
	onDone: () => void;
	switchSection: () => void;
	managePeer: (action: "r" | "x", peer: string) => string | undefined;
}

export class AgentHubMessagesView {
	#registry: AgentRegistry;
	#irc: IrcBus;
	#remote: AgentHubRemote | undefined;
	#sectionTabs: () => string;
	#requestRender: () => void;
	#onDone: () => void;
	#switchSection: () => void;
	#managePeer: (action: "r" | "x", peer: string) => string | undefined;
	#hitRows: Array<number | undefined> = [];
	#disposed = false;

	constructor(deps: AgentHubMessagesViewDeps) {
		this.#registry = deps.registry;
		this.#irc = deps.irc;
		this.#remote = deps.remote;
		this.#sectionTabs = deps.renderTabs;
		this.#requestRender = deps.requestRender;
		this.#onDone = deps.onDone;
		this.#switchSection = deps.switchSection;
		this.#managePeer = deps.managePeer;
		this.#refreshMessages();
		if (this.#remote) void this.#refreshRemoteMessages();
	}

	get composing(): boolean {
		return this.#messageComposing;
	}

	get splitVisible(): boolean {
		return this.#messagesSplitVisible;
	}

	dispose(): void {
		this.#disposed = true;
	}

	refresh(): void {
		this.#refreshMessages();
	}

	sectionChanged(): void {
		this.#messageFocus = "conversations";
		this.#messageThreadOpen = false;
		this.#refreshMessages();
	}

	handleInput(keyData: string): void {
		if (this.#messageComposing) {
			this.#handleMessageComposerInput(keyData);
			return;
		}
		this.#handleMessagesInput(keyData);
	}

	handleWheel(delta: -1 | 1): void {
		if (this.#messageFocus === "thread") {
			const messages = this.#conversations[this.#selectedConversationRow]?.messages ?? [];
			this.#selectedMessageRow = Math.max(0, Math.min(this.#selectedMessageRow + delta, messages.length - 1));
		} else if (this.#conversations.length > 0) {
			this.#selectedConversationRow = Math.max(
				0,
				Math.min(this.#selectedConversationRow + delta, this.#conversations.length - 1),
			);
			this.#selectedMessageRow = (this.#conversations[this.#selectedConversationRow]?.messages.length ?? 1) - 1;
		}
		this.#requestRender();
	}

	clickItem(index: number): void {
		if (index === this.#selectedConversationRow) {
			this.#messageFocus = "thread";
			this.#messageThreadOpen = true;
			this.#markSelectedConversationRead();
		} else {
			this.#selectedConversationRow = index;
			this.#selectedMessageRow = (this.#conversations[this.#selectedConversationRow]?.messages.length ?? 1) - 1;
		}
		this.#requestRender();
	}

	hitTest(line: number): number | undefined {
		return this.#hitRows[line];
	}

	render(width: number, termHeight: number, hitRows: Array<number | undefined>): string[] {
		this.#hitRows = hitRows;
		return this.#renderMessagesTable(width, termHeight);
	}
	#conversations: IrcConversation[] = [];
	#selectedConversationRow = 0;
	#selectedMessageRow = 0;
	#messageFocus: "conversations" | "thread" = "conversations";
	#messageDraft = "";
	#messageComposing = false;
	#messageSending = false;
	#messageThreadOpen = false;
	#messagesSplitVisible = false;
	#messageReplyTo: string | undefined;
	#messageNotice: string | undefined;
	#remoteHistoryRecords: IrcHistoryRecord[] = [];
	#remoteMessagesFetchInFlight = false;
	#remoteMessageReadAt = new Map<string, IrcReadCursor>();
	#conversationMessageCounts = new Map<string, number>();
	#ensureComposableConversations(): void {
		const byId = new Map(this.#conversations.map(conversation => [conversation.id, conversation]));
		const ensure = (id: string, label: string, participants: string[]): void => {
			if (byId.has(id)) return;
			const conversation: IrcConversation = {
				id,
				label,
				participants,
				messages: [],
				lastMessageAt: 0,
				unread: 0,
			};
			byId.set(id, conversation);
			this.#conversations.push(conversation);
		};
		ensure("broadcast:all", "All agents", [MAIN_AGENT_ID]);
		for (const ref of this.#registry.listVisibleTo(MAIN_AGENT_ID)) {
			if (ref.id === MAIN_AGENT_ID || ref.kind === "advisor") continue;
			const id = `direct:${[MAIN_AGENT_ID, ref.id].sort().join(":")}`;
			ensure(id, ref.displayName || ref.id, [MAIN_AGENT_ID, ref.id]);
		}
		this.#conversations.sort((a, b) => {
			const aLive = a.messages.length > 0 ? 1 : 0;
			const bLive = b.messages.length > 0 ? 1 : 0;
			if (aLive !== bLive) return bLive - aLive;
			if (a.lastMessageAt !== b.lastMessageAt) return b.lastMessageAt - a.lastMessageAt;
			if (a.id === "broadcast:all") return 1;
			if (b.id === "broadcast:all") return -1;
			return a.id.localeCompare(b.id);
		});
	}

	#refreshMessages(): void {
		const selectedId = this.#conversations[this.#selectedConversationRow]?.id;
		if (this.#remote) void this.#refreshRemoteMessages();
		const records = this.#remote ? this.#remoteHistoryRecords : this.#irc.historyRecords();
		this.#conversations = deriveIrcConversations(records, {
			registry: this.#registry,
			viewerId: MAIN_AGENT_ID,
			readAt: id =>
				this.#remote
					? (this.#remoteMessageReadAt.get(id) ?? { timestamp: 0, messageId: "" })
					: this.#irc.history.readAt(id),
		});
		this.#ensureComposableConversations();
		const kept = selectedId ? this.#conversations.findIndex(conversation => conversation.id === selectedId) : -1;
		if (kept >= 0) {
			this.#selectedConversationRow = kept;
		} else {
			const withMessages = this.#conversations.findIndex(conversation => conversation.messages.length > 0);
			this.#selectedConversationRow =
				withMessages >= 0
					? withMessages
					: Math.min(this.#selectedConversationRow, Math.max(0, this.#conversations.length - 1));
		}
		const selected = this.#conversations[this.#selectedConversationRow];
		if (!selected) {
			this.#selectedMessageRow = 0;
		} else {
			const previousCount = this.#conversationMessageCounts.get(selected.id) ?? 0;
			const nextCount = selected.messages.length;
			this.#conversationMessageCounts.set(selected.id, nextCount);
			if (!selectedId || (previousCount === 0 && nextCount > 0)) {
				this.#selectedMessageRow = Math.max(0, nextCount - 1);
			} else {
				this.#selectedMessageRow = Math.min(this.#selectedMessageRow, Math.max(0, nextCount - 1));
			}
		}
	}

	#markSelectedConversationRead(): void {
		const conversation = this.#conversations[this.#selectedConversationRow];
		const lastMessage = conversation?.messages.at(-1);
		if (!conversation || !lastMessage) return;
		const cursor = { timestamp: lastMessage.ts, messageId: lastMessage.id };
		if (this.#remote) this.#remoteMessageReadAt.set(conversation.id, cursor);
		else this.#irc.history.markRead(conversation.id, cursor);
		conversation.unread = 0;
	}

	async #refreshRemoteMessages(): Promise<void> {
		if (!this.#remote?.readMessages || this.#remoteMessagesFetchInFlight) return;
		this.#remoteMessagesFetchInFlight = true;
		try {
			const records = await this.#remote.readMessages();
			if (!records || this.#disposed) return;
			this.#remoteHistoryRecords = records;
			this.#refreshMessages();
			this.#requestRender();
		} finally {
			this.#remoteMessagesFetchInFlight = false;
		}
	}
	#renderMessagesTable(width: number, termHeight: number): string[] {
		this.#hitRows.length = 0;
		const contentRows = Math.max(1, termHeight - 4);
		const body: string[] = [this.#sectionTabs()];
		const split = width >= 90 && !this.#messageThreadOpen;
		this.#messagesSplitVisible = split;
		if (split || this.#messageThreadOpen) this.#markSelectedConversationRead();
		const conversationWidth = split ? Math.max(24, Math.min(36, Math.floor(width * 0.3))) : Math.max(1, width - 4);
		const threadWidth = split ? Math.max(1, width - conversationWidth - 7) : Math.max(1, width - 4);
		const selected = this.#conversations[this.#selectedConversationRow];
		const chromeRows = this.#messageComposing || this.#messageNotice ? 1 : 0;
		const paneRows = Math.max(1, contentRows - body.length - chromeRows);
		const conversationLines = this.#renderConversationList(conversationWidth, paneRows);
		const threadLines = this.#renderMessageThread(selected, threadWidth, paneRows);
		const conversationStart = this.#conversationListStart(paneRows);

		if (split) {
			for (let index = 0; index < paneRows; index++) {
				const left = conversationLines[index] ?? "";
				const leftWidth = visibleWidth(left);
				const right = threadLines[index] ?? "";
				body.push(`${left}${padding(Math.max(0, conversationWidth - leftWidth))} ${theme.fg("dim", "│")} ${right}`);
				if (index > 0 && conversationStart + index - 1 < this.#conversations.length) {
					this.#hitRows[body.length] = conversationStart + index - 1;
				}
			}
		} else if (this.#messageThreadOpen && selected) {
			body.push(...threadLines);
		} else {
			body.push(...conversationLines);
			for (let index = 1; index < conversationLines.length; index++) {
				if (conversationStart + index - 1 < this.#conversations.length) {
					this.#hitRows[1 + index] = conversationStart + index - 1;
				}
			}
		}

		if (this.#messageComposing) {
			const reply = this.#messageReplyTo ? `reply ${this.#messageReplyTo} · ` : "";
			body.push(
				`${theme.bold(theme.fg("accent", "Message"))} ${theme.fg("dim", reply)}${truncateToWidth(this.#messageDraft, Math.max(1, width - 18))}${theme.fg("accent", "▌")}`,
			);
		} else if (this.#messageNotice) {
			body.push(theme.fg("warning", truncateToWidth(this.#messageNotice, Math.max(1, width - 4))));
		}
		while (body.length < contentRows) body.push("");

		const lines = [topBorder(width, "Agent Hub")];
		for (const line of body.slice(0, contentRows)) lines.push(row(line, width));
		lines.push(divider(width));
		lines.push(
			row(
				theme.fg(
					"dim",
					"1:agents  2:activity  Tab:pane  j/k:select  Enter:open  c:compose  R:reply  r/x:manage  Esc:close",
				),
				width,
			),
		);
		lines.push(bottomBorder(width));
		return lines;
	}

	#conversationListStart(rows: number): number {
		const budget = Math.max(0, rows - 1);
		const selected = Math.min(this.#selectedConversationRow, Math.max(0, this.#conversations.length - 1));
		return Math.max(0, Math.min(selected - Math.floor(budget / 2), Math.max(0, this.#conversations.length - budget)));
	}

	#renderConversationList(width: number, rows: number): string[] {
		const lines = [theme.bold("Conversations")];
		if (this.#conversations.length === 0) {
			lines.push(theme.fg("muted", "No IRC messages recorded yet"));
		} else {
			const budget = Math.max(0, rows - 1);
			const selected = Math.min(this.#selectedConversationRow, this.#conversations.length - 1);
			const start = this.#conversationListStart(rows);
			for (let index = start; index < Math.min(this.#conversations.length, start + budget); index++) {
				const conversation = this.#conversations[index]!;
				const cursor = index === selected ? theme.fg("accent", theme.nav.cursor) : " ";
				const unread = conversation.unread > 0 ? theme.fg("warning", ` ${conversation.unread}`) : "";
				const preview = sanitizeDisplayText(conversation.messages.at(-1)?.body ?? "");
				const label = sanitizeDisplayText(conversation.label);
				const prefix = `${cursor} ${theme.bold(label)}${unread} `;
				lines.push(
					`${prefix}${theme.fg("muted", truncateToWidth(preview, Math.max(1, width - visibleWidth(prefix))))}`,
				);
			}
		}
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	}

	#renderMessageThread(conversation: IrcConversation | undefined, width: number, rows: number): string[] {
		if (!conversation) {
			return [
				theme.fg("muted", "Select a conversation"),
				...Array.from({ length: Math.max(0, rows - 1) }, () => ""),
			];
		}
		const lines = [
			theme.bold(`${sanitizeDisplayText(conversation.label)} · ${conversation.messages.length} messages`),
		];
		const budget = Math.max(0, rows - 1);
		const selected = Math.min(this.#selectedMessageRow, Math.max(0, conversation.messages.length - 1));
		const start = Math.max(
			0,
			Math.min(selected - Math.floor(budget / 2), Math.max(0, conversation.messages.length - budget)),
		);
		for (let index = start; index < conversation.messages.length; index++) {
			const message = conversation.messages[index]!;
			const cursor =
				this.#messageFocus === "thread" && index === selected ? theme.fg("accent", theme.nav.cursor) : " ";
			const direction = `${sanitizeDisplayText(message.from)} → ${sanitizeDisplayText(message.to)}`;
			const reply = message.replyTo ? ` ↳${sanitizeDisplayText(message.replyTo)}` : "";
			const outcome =
				message.outcome === "failed"
					? theme.fg("error", "×")
					: message.outcome === "pending"
						? theme.fg("warning", "…")
						: theme.fg("success", "✓");
			const error = message.outcome === "failed" && message.error ? ` ${sanitizeDisplayText(message.error)}` : "";
			const prefix = `${cursor} ${activityClock(message.ts)} ${outcome} ${theme.fg("muted", direction)}${theme.fg("dim", reply)} `;
			lines.push(
				`${prefix}${truncateToWidth(sanitizeLine(message.body + error), Math.max(1, width - visibleWidth(prefix)))}`,
			);
		}
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	}
	#handleMessageComposerInput(keyData: string): void {
		if (matchesKey(keyData, "escape")) {
			this.#messageComposing = false;
			this.#messageDraft = "";
			this.#messageReplyTo = undefined;
		} else if (matchesKey(keyData, "backspace")) {
			this.#messageDraft = this.#messageDraft.slice(0, -1);
		} else if (matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") {
			if (!this.#messageSending) void this.#submitMessage();
		} else if (keyData.length === 1 && keyData >= " " && keyData !== "\u007f") {
			this.#messageDraft += keyData;
		} else {
			return;
		}
		this.#requestRender();
	}

	#handleMessagesInput(keyData: string): void {
		if (matchesKey(keyData, "escape")) {
			if (this.#messageThreadOpen || this.#messageFocus === "thread") {
				this.#messageThreadOpen = false;
				this.#messageFocus = "conversations";
				this.#requestRender();
			} else {
				this.#onDone();
			}
			return;
		}
		if (matchesKey(keyData, "left")) {
			if (this.#messageFocus === "thread") {
				this.#messageFocus = "conversations";
				this.#messageThreadOpen = false;
				this.#requestRender();
			} else {
				this.#switchSection();
			}
			return;
		}
		if (matchesKey(keyData, "right") || matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") {
			if (this.#conversations.length > 0) {
				this.#messageFocus = "thread";
				this.#messageThreadOpen = true;
				this.#markSelectedConversationRead();
				this.#requestRender();
			}
			return;
		}
		if (matchesKey(keyData, "tab") || keyData === "\t") {
			this.#messageFocus = this.#messageFocus === "conversations" ? "thread" : "conversations";
			if (this.#messageFocus === "thread") {
				// Narrow layout only shows the thread when drilled in; wide split is already visible.
				if (!this.#messagesSplitVisible) this.#messageThreadOpen = true;
				this.#markSelectedConversationRead();
			} else {
				this.#messageThreadOpen = false;
			}
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "j") || matchesSelectDown(keyData)) {
			this.#moveMessageSelection(1);
			return;
		}
		if (matchesKey(keyData, "k") || matchesSelectUp(keyData)) {
			this.#moveMessageSelection(-1);
			return;
		}
		if (keyData === "c") {
			this.#ensureComposableConversations();
			if (this.#conversations.length === 0) {
				this.#messageNotice = "No agents available to message";
				this.#requestRender();
				return;
			}
			this.#messageComposing = true;
			this.#messageDraft = "";
			this.#messageReplyTo = undefined;
			this.#messageNotice = undefined;
			this.#requestRender();
			return;
		}
		if (keyData === "R") {
			const conversation = this.#conversations[this.#selectedConversationRow];
			this.#messageReplyTo = conversation?.messages[this.#selectedMessageRow]?.id;
			this.#messageComposing = Boolean(conversation);
			this.#messageDraft = "";
			this.#messageNotice = undefined;
			this.#requestRender();
			return;
		}
		if (keyData === "r" || keyData === "x") {
			this.#manageConversationPeer(keyData);
		}
	}

	#moveMessageSelection(delta: -1 | 1): void {
		if (this.#messageFocus === "thread") {
			const messages = this.#conversations[this.#selectedConversationRow]?.messages ?? [];
			this.#selectedMessageRow = Math.max(0, Math.min(this.#selectedMessageRow + delta, messages.length - 1));
		} else if (this.#conversations.length > 0) {
			this.#selectedConversationRow = Math.max(
				0,
				Math.min(this.#selectedConversationRow + delta, this.#conversations.length - 1),
			);
			this.#selectedMessageRow = (this.#conversations[this.#selectedConversationRow]?.messages.length ?? 1) - 1;
		}
		this.#requestRender();
	}

	#conversationPeer(): string | undefined {
		const conversation = this.#conversations[this.#selectedConversationRow];
		if (!conversation || conversation.id === "broadcast:all" || !conversation.participants.includes(MAIN_AGENT_ID)) {
			return undefined;
		}
		return conversation.participants.find(id => id !== MAIN_AGENT_ID);
	}

	#manageConversationPeer(action: "r" | "x"): void {
		const peer = this.#conversationPeer();
		if (!peer) {
			this.#messageNotice = "This conversation has no single Main-session peer to manage";
			this.#requestRender();
			return;
		}
		const notice = this.#managePeer(action, peer);
		if (notice) this.#messageNotice = notice;
		this.#requestRender();
	}

	async #submitMessage(): Promise<void> {
		const body = this.#messageDraft.trim();
		if (!body) return;
		this.#ensureComposableConversations();
		const conversation = this.#conversations[this.#selectedConversationRow];
		if (!conversation) {
			this.#messageNotice = "Select a recipient conversation (or All agents) before sending";
			this.#requestRender();
			return;
		}
		this.#messageSending = true;
		this.#messageNotice = undefined;
		try {
			if (this.#remote) {
				const target = conversation.id === "broadcast:all" ? "all" : this.#conversationPeer();
				if (!target) {
					this.#messageNotice = "Sibling-agent conversations are read-only from Main";
					return;
				}
				if (!this.#remote.sendMessage) {
					this.#messageNotice = "Messaging is unavailable on this collab host";
					return;
				}
				const error = await this.#remote.sendMessage(target, body, this.#messageReplyTo);
				this.#messageNotice = error ?? (target === "all" ? "Broadcast delivered" : `Delivered to ${target}`);
				if (!error) {
					this.#messageDraft = "";
					this.#messageReplyTo = undefined;
					this.#messageComposing = false;
					await this.#refreshRemoteMessages();
				}
				return;
			}
			if (conversation.id === "broadcast:all") {
				const targets = this.#registry
					.listVisibleTo(MAIN_AGENT_ID)
					.filter(
						ref =>
							ref.id !== MAIN_AGENT_ID &&
							ref.kind !== "advisor" &&
							(ref.status === "running" || ref.status === "idle"),
					);
				const broadcastId = Snowflake.next();
				const receipts = await Promise.all(
					targets.map(ref =>
						this.#irc.send({
							from: MAIN_AGENT_ID,
							to: ref.id,
							body,
							replyTo: this.#messageReplyTo,
							broadcastId,
						}),
					),
				);
				const failed = receipts.filter(receipt => receipt.outcome === "failed").length;
				this.#messageNotice =
					targets.length === 0
						? "No live agents available for broadcast"
						: failed > 0
							? `Broadcast delivered to ${targets.length - failed}/${targets.length} agents`
							: `Broadcast delivered to ${targets.length} agents`;
			} else {
				const peer = this.#conversationPeer();
				if (!peer) {
					this.#messageNotice = "Sibling-agent conversations are read-only from Main";
					return;
				}
				const receipt = await this.#irc.send({
					from: MAIN_AGENT_ID,
					to: peer,
					body,
					replyTo: this.#messageReplyTo,
				});
				this.#messageNotice =
					receipt.outcome === "failed" ? (receipt.error ?? `Delivery to ${peer} failed`) : `Delivered to ${peer}`;
			}
			this.#messageDraft = "";
			this.#messageReplyTo = undefined;
			this.#messageComposing = false;
			this.#refreshMessages();
		} finally {
			this.#messageSending = false;
			this.#requestRender();
		}
	}
}
