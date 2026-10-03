import { readdirSync } from "node:fs";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Job, JobStore } from "../jobs.ts";
import type { Supervisor } from "../supervisor.ts";

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }], details: undefined };
}

export function describeJob(job: Job): string {
	const lines = [`job ${job.id} (${job.project}): ${job.status}`];
	if (job.question) lines.push(`question: ${job.question}`);
	if (job.summary) lines.push(`summary: ${job.summary}`);
	if (job.error) lines.push(`error: ${job.error}`);
	return lines.join("\n");
}

export function delegateExtension(supervisor: Supervisor, store: JobStore, workspacesDir: string): ExtensionFactory {
	const projects = () =>
		readdirSync(workspacesDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);

	return (pi) => {
		pi.registerTool({
			name: "delegate",
			label: "Delegate",
			description:
				"Start a new job: hand a task to a fresh worker agent that runs in the background inside a project workspace. " +
				"Returns a job id at once; you are told when the worker finishes or asks a question. " +
				"A fresh worker knows nothing about earlier jobs and sees only the brief, so make it complete. " +
				"Never use this to change, correct or extend what an earlier job did; use message_job with that job's id.",
			parameters: Type.Object({
				project: Type.String({ description: "Name of the project workspace. Use list_projects to see them." }),
				brief: Type.String({ description: "What to do, the constraints, and what the person cares about." }),
			}),
			execute: async (_toolCallId, params) => {
				if (!projects().includes(params.project)) {
					throw new Error(`Unknown project "${params.project}". Known projects: ${projects().join(", ") || "none"}`);
				}
				const job = supervisor.delegate(params.project, params.brief);
				return text(`Started job ${job.id} in ${job.project}.`);
			},
		});

		pi.registerTool({
			name: "message_job",
			label: "Message job",
			description:
				"Send a message to an existing job: the answer to the question a waiting job asked, or a follow-up to a finished job. " +
				"The same worker resumes with everything it did before. Use this, not delegate, for anything that continues a job.",
			parameters: Type.Object({
				job_id: Type.String(),
				message: Type.String(),
			}),
			execute: async (_toolCallId, params) => {
				const job = supervisor.message(params.job_id, params.message);
				return text(`Resumed job ${job.id}.`);
			},
		});

		pi.registerTool({
			name: "list_jobs",
			label: "List jobs",
			description: "List delegated jobs with their status, pending question, and result.",
			parameters: Type.Object({}),
			execute: async () => text(store.list().map(describeJob).join("\n\n") || "No jobs yet."),
		});

		pi.registerTool({
			name: "list_projects",
			label: "List projects",
			description: "List the project workspaces a job can be delegated into.",
			parameters: Type.Object({}),
			execute: async () => text(projects().join("\n") || "No projects."),
		});
	};
}
