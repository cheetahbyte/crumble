import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createAgentSession, DefaultResourceLoader, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { config, createRunner } from "./config.ts";
import { delegateExtension, describeJob } from "./extensions/delegate.ts";
import { type Job, JobStore } from "./jobs.ts";
import { Supervisor } from "./supervisor.ts";

const CRUMBLE_PROMPT = [
	"You are Crumble, a personal assistant. You talk with one person and get work done for them.",
	"You do not do project work yourself. Delegate it to a worker with the delegate tool, then stay available to talk.",
	"When a worker asks a question, answer it with answer_job only if the answer follows from what the person has told you.",
	"If it is a matter of their preference, or anything you would be guessing, ask the person and pass their answer on.",
	"When a job finishes, tell the person the outcome in a few sentences.",
].join("\n");

// Crumble gets its own agent directory so the host's Pi extensions, skills and context files stay out of it.
const agentDir = join(config.dataDir, "tenants", "default", "agent");
const cwd = join(config.dataDir, "tenants", "default", "home");
mkdirSync(agentDir, { recursive: true });
mkdirSync(cwd, { recursive: true });
mkdirSync(config.jobsDir, { recursive: true });
mkdirSync(config.workspacesDir, { recursive: true });

const store = new JobStore(join(config.dataDir, "crumble.db"));
const supervisor = new Supervisor({
	store,
	runner: createRunner(),
	provider: config.provider,
	model: config.model,
	onSettled: (job) => notify(job),
});

const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel(config.provider, config.model);
if (!model) throw new Error(`Model ${config.provider}/${config.model} is not available`);

const resourceLoader = new DefaultResourceLoader({
	cwd,
	agentDir,
	systemPrompt: CRUMBLE_PROMPT,
	extensionFactories: [delegateExtension(supervisor, store, config.workspacesDir)],
});
await resourceLoader.reload();

const { session } = await createAgentSession({
	cwd,
	agentDir,
	modelRuntime,
	model,
	resourceLoader,
	noTools: "builtin",
});

session.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	} else if (event.type === "tool_execution_start") {
		process.stdout.write(`\n[${event.toolName}]\n`);
	} else if (event.type === "agent_settled") {
		process.stdout.write("\n> ");
	}
});

function send(text: string): void {
	session.prompt(text, { streamingBehavior: "followUp" }).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
	});
}

function notify(job: Job): void {
	process.stdout.write(`\n[job ${job.id} is ${job.status}]\n`);
	send(`Update from the worker supervisor, not from the person:\n${describeJob(job)}`);
}

const input = createInterface({ input: process.stdin });
process.stdout.write("Crumble is ready.\n> ");
input.on("line", (line) => {
	if (line.trim().length > 0) send(line);
});
input.on("close", () => {
	// Jobs keep the process alive until they settle.
	session.waitForIdle().then(() => session.dispose());
});
