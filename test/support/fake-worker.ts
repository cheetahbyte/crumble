// Stands in for `pi --mode rpc` in tests. Behaviour is chosen by the prompt text:
// "ask: <q>" asks a question, "crash" exits mid-run, anything else finishes with an echo.
import { createInterface } from "node:readline";

function emit(record: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(record)}\n`);
}

let lastText: string | null = null;

createInterface({ input: process.stdin }).on("line", (line) => {
	const command = JSON.parse(line) as { id: string; type: string; message?: string };
	if (command.type === "abort") {
		emit({ id: command.id, type: "response", command: "abort", success: true, data: undefined });
		emit({ type: "agent_settled" });
	} else if (command.type === "prompt") {
		const message = command.message ?? "";
		emit({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
		if (message === "crash") {
			process.stderr.write("boom\n");
			process.exit(3);
		}
		if (message === "hang") return;
		if (message === "malformed") {
			process.stdout.write("{not json}\n");
			return;
		}
		if (message.startsWith("ask: ")) {
			emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "ask", args: { question: message.slice(5) } });
			lastText = null;
		} else {
			lastText = `did: ${message}`;
		}
		emit({ type: "agent_settled" });
	} else if (command.type === "get_last_assistant_text") {
		emit({ id: command.id, type: "response", command: command.type, success: true, data: { text: lastText } });
	}
});
