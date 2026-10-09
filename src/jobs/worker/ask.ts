import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask",
		label: "Ask",
		description:
			"Ask the person who delegated this task a question you cannot answer from the brief or the workspace. " +
			"Calling it suspends the task: you are stopped and later resumed with the answer as a new message. " +
			"Ask one question per call and do not call any other tool in the same turn.",
		parameters: Type.Object({
			question: Type.String({ description: "The question, with enough context to answer it without seeing your work." }),
		}),
		execute: async (_toolCallId, params) => ({
			content: [{ type: "text", text: "Question recorded. Stop now; the answer will arrive as a new message." }],
			details: { question: params.question },
			terminate: true,
		}),
	});
}
