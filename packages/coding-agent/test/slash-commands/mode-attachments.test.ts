import { describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { SubmittedUserInput } from "@oh-my-pi/pi-coding-agent/modes/types";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";

type Attachments = Pick<SubmittedUserInput, "images" | "imageLinks">;

function createHarness(
	inputResult: { images?: ImageContent[]; text?: string } | Promise<{ images?: ImageContent[]; text?: string }>,
) {
	const oldImage: ImageContent = { type: "image", data: "b2xk", mimeType: "image/png" };
	const handlePlanModeCommand = vi.fn(async (_prompt?: string, _input?: Attachments) => true);
	const handleVibeModeCommand = vi.fn(async (_prompt?: string, _input?: Attachments) => true);
	const handleGoalModeCommand = vi.fn(async (_prompt?: string, _input?: Attachments) => true);
	const handleGuidedGoalCommand = vi.fn(async (_prompt?: string, _input?: Attachments) => true);
	let editorText = "";
	let imageLinks: (string | undefined)[] | undefined;
	const editor = {
		onSubmit: undefined as undefined | ((text: string) => Promise<void>),
		addToHistory: vi.fn(),
		getText: () => editorText,
		getExpandedText: () => editorText,
		setText(text: string) {
			editorText = text;
		},
		// The stub skips chip collapsing so assertions read the wire-format text.
		setCollapsedText(text: string) {
			editorText = text;
		},
		pendingImages: [oldImage],
		pendingImageLinks: ["file:///old.png"],
		imageLinks,
		clearDraft() {
			editorText = "";
			this.pendingImages = [];
			this.pendingImageLinks = [];
			this.imageLinks = undefined;
		},
	};
	const showError = vi.fn();
	const replacementBlob = {
		hash: "0".repeat(64),
		path: "file:///replacement",
		displayPath: "file:///replacement.png",
		get ref() {
			return `blob:sha256:${this.hash}`;
		},
	};
	const ctx = createInteractiveModeContext({
		editor,
		session: {
			isStreaming: false,
			isCompacting: false,
			queuedMessageCount: 0,
			customCommands: [],
			promptTemplates: [],
			extensionRunner: {
				hasHandlers: (event: string) => event === "input",
				emitInput: vi.fn(async () => inputResult),
				getCommand: () => undefined,
			},
		},
		sessionManager: {
			putBlob: vi.fn(async () => replacementBlob),
		},
		focusedAgentId: undefined,
		skillCommands: new Map(),
		fileSlashCommands: new Set<string>(),
		collabGuest: undefined,
		ui: { requestRender: vi.fn() },
		compactionQueuedMessages: [],
		updatePendingMessagesDisplay: vi.fn(),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError,
		handlePlanModeCommand,
		handleVibeModeCommand,
		handleGoalModeCommand,
		handleGuidedGoalCommand,
	});
	const controller = new InputController(ctx);
	controller.setupEditorSubmitHandler();
	const onSubmit = ctx.editor.onSubmit;
	if (!onSubmit) throw new Error("expected editor submit handler");
	return {
		editor: ctx.editor,
		submit: async (text: string) => onSubmit(text),
		showError,
		handlePlanModeCommand,
		handleVibeModeCommand,
		handleGoalModeCommand,
		handleGuidedGoalCommand,
	};
}

describe("mode command attachments", () => {
	it("uses extension-replaced images and regenerated links", async () => {
		const replacements: ImageContent[] = [{ type: "image", data: "bmV3", mimeType: "image/jpeg" }];
		const harness = createHarness({ images: replacements });

		await harness.submit("/plan inspect this");

		const input = harness.handlePlanModeCommand.mock.calls[0]?.[1];
		expect(input?.images).toBe(replacements);
		expect(input?.imageLinks).toEqual(["file:///replacement.png"]);
		expect(harness.editor.pendingImages).toEqual([]);
		expect(harness.editor.pendingImageLinks).toEqual([]);
	});

	it("does not submit images removed by an extension", async () => {
		const harness = createHarness({ images: [] });

		await harness.submit("/goal keep this private");

		expect(harness.handleGoalModeCommand).toHaveBeenCalledWith("keep this private", undefined);
		expect(harness.editor.pendingImages).toEqual([]);
		expect(harness.editor.pendingImageLinks).toEqual([]);
	});

	it("preserves source links when an extension leaves attachments unchanged", async () => {
		const harness = createHarness({});

		await harness.submit("/vibe inspect this [Image #1]");

		expect(harness.handleVibeModeCommand).toHaveBeenCalledWith(
			"inspect this [Image #1]",
			expect.objectContaining({ imageLinks: ["file:///old.png"] }),
		);
		expect(harness.editor.pendingImages).toEqual([]);
		expect(harness.editor.pendingImageLinks).toEqual([]);
	});
	it("restores attachments when a mode command does not submit", async () => {
		const harness = createHarness({});
		harness.handleGoalModeCommand.mockResolvedValueOnce(false);

		await harness.submit("/goal show [Image #1]");

		expect(harness.editor.pendingImages).toHaveLength(1);
		expect(harness.editor.pendingImageLinks).toEqual(["file:///old.png"]);
	});

	it("detaches submitted images before awaiting input extensions", async () => {
		const inputResult = Promise.withResolvers<{ images?: ImageContent[] }>();
		const harness = createHarness(inputResult.promise);
		const submission = harness.submit("/plan inspect this [Image #1]");

		const laterImage: ImageContent = { type: "image", data: "bmV3", mimeType: "image/png" };
		harness.editor.setText("later draft");
		harness.editor.pendingImages.push(laterImage);
		harness.editor.pendingImageLinks.push("file:///later.png");
		inputResult.resolve({});
		await submission;

		expect(harness.handlePlanModeCommand.mock.calls[0]?.[1]?.images).toHaveLength(1);
		expect(harness.editor.getText()).toBe("later draft");
		expect(harness.editor.pendingImages).toEqual([laterImage]);
		expect(harness.editor.pendingImageLinks).toEqual(["file:///later.png"]);
	});
	it("preserves later images when an extension rewrites input into a mode command", async () => {
		const inputResult = Promise.withResolvers<{ images?: ImageContent[]; text?: string }>();
		const harness = createHarness(inputResult.promise);
		const submission = harness.submit("inspect this");

		const laterImage: ImageContent = { type: "image", data: "bmV3", mimeType: "image/png" };
		harness.editor.setText("later draft");
		harness.editor.pendingImages.push(laterImage);
		harness.editor.pendingImageLinks.push("file:///later.png");
		inputResult.resolve({ text: "/plan inspect this" });
		await submission;

		expect(harness.handlePlanModeCommand).toHaveBeenCalled();
		expect(harness.editor.getText()).toBe("later draft");
		expect(harness.editor.pendingImages).toEqual([laterImage]);
		expect(harness.editor.pendingImageLinks).toEqual(["file:///later.png"]);
	});

	it("restores a failed mode command into an empty editor", async () => {
		const failedPlan = createHarness({});
		failedPlan.handlePlanModeCommand.mockRejectedValueOnce(new Error("plan setup failed"));
		const planSubmission = failedPlan.submit("/plan inspect this [Image #1]");

		await planSubmission;
		expect(failedPlan.editor.getText()).toBe("/plan inspect this [Image #1]");
		expect(failedPlan.editor.pendingImages).toHaveLength(1);
		expect(failedPlan.editor.pendingImageLinks).toEqual(["file:///old.png"]);
		expect(failedPlan.showError).toHaveBeenCalledWith("plan setup failed");
	});

	it.each([
		["/plan", "handlePlanModeCommand"],
		["/vibe", "handleVibeModeCommand"],
		["/goal", "handleGoalModeCommand"],
		["/guided-goal", "handleGuidedGoalCommand"],
	] as const)("restores a failed %s beside a later draft, remapping its image markers", async (command, handler) => {
		const harness = createHarness({});
		const laterImage: ImageContent = { type: "image", data: "bmV3", mimeType: "image/png" };
		harness[handler].mockImplementationOnce(async () => {
			harness.editor.setText("later [Image #1]");
			harness.editor.pendingImages = [laterImage];
			harness.editor.pendingImageLinks = ["file:///later.png"];
			throw new Error("setup failed");
		});
		const submission = harness.editor.onSubmit?.(`${command} inspect this [Image #1]`);
		if (!submission) throw new Error("expected editor submit handler");

		await submission;
		expect(harness.editor.getText()).toBe(`${command} inspect this [Image #2]\n\nlater [Image #1]`);
		expect(harness.editor.pendingImages).toHaveLength(2);
		expect(harness.editor.pendingImages[0]).toBe(laterImage);
		expect(harness.editor.pendingImageLinks).toEqual(["file:///later.png", "file:///old.png"]);
		expect(harness.showError).toHaveBeenCalledWith("setup failed");
	});
});
