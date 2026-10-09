import { readdirSync } from "node:fs";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Job, JobStore } from "../jobs.ts";
import type { Supervisor } from "../supervisor.ts";
import { toolResult } from "./result.ts";

export function describeJob(job: Job): string {
	const lines = [`job ${job.id} (${job.project}): ${job.status}`];
	if (job.question) lines.push(`question: ${job.question}`);
	if (job.summary) lines.push(`summary: ${job.summary}`);
	if (job.error) lines.push(`error: ${job.error}`);
	return lines.join("\n");
}

export function delegateExtension(supervisor: Supervisor, store: JobStore, workspacesDir: string, context: () => string = () => "", canDelegate: () => boolean = () => true): ExtensionFactory {
	const projects = () =>
		readdirSync(workspacesDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);

	return (pi) => {
		pi.registerTool({
			name: "delegate",
			label: "Delegate",
			description:
					"Start any task requiring research, code, files, shell commands, or building a new capability. A worker runs in the background in a private workspace. " +
				"Returns a job id at once; you are told when the worker finishes or asks a question. " +
				"A fresh worker knows nothing about earlier jobs and sees only the brief, so make it complete. " +
				"Never use this to change, correct or extend what an earlier job did; use message_job with that job's id.",
			parameters: Type.Object({
				project: Type.Optional(Type.String({ description: "Private workspace name; defaults to personal. Use list_projects or create_workspace." })),
				brief: Type.String({ description: "What to do, the constraints, and what the person cares about." }),
			}),
			execute: async (_toolCallId, params) => {
				if (!canDelegate()) throw new Error("Quiet monitors must finish their checks in the current turn. Use browser or run_plugin directly; background jobs report independently.");
				const project = params.project ?? "personal";
				if (!projects().includes(project)) {
					throw new Error(`Unknown workspace "${project}". Known workspaces: ${projects().join(", ") || "none"}`);
				}
				const saved = context();
				const job = supervisor.delegate(project, `${params.brief}${saved ? `\n\nRelevant saved context:\n${saved}` : ""}`);
				return toolResult(`Started job ${job.id} in ${job.project}.`);
			},
		});

		pi.registerTool({
			name: "message_job",
			label: "Message job",
			description:
					"Send an answer, follow-up, or explicitly requested retry to an existing job. " +
				"The same worker resumes with everything it did before. Use this, not delegate, for anything that continues a job.",
			parameters: Type.Object({
				job_id: Type.String(),
				message: Type.String(),
			}),
			execute: async (_toolCallId, params) => {
				if (!canDelegate()) throw new Error("Quiet monitors cannot resume background jobs; use browser or run_plugin directly so notification decisions stay with this run.");
				const job = supervisor.message(params.job_id, params.message);
				return toolResult(`Resumed job ${job.id}.`);
			},
		});

		pi.registerTool({
			name: "cancel_job",
			label: "Cancel job",
			description: "Stop a running worker job. Work already performed is retained; cancellation does not undo external actions.",
			parameters: Type.Object({ job_id: Type.String() }),
			execute: async (_id, params) => {
				await supervisor.cancel(params.job_id);
				return toolResult(`Cancellation requested for job ${params.job_id}.`);
			},
		});

		pi.registerTool({
			name: "list_jobs",
			label: "List jobs",
			description: "List delegated jobs with their status, pending question, and result.",
			parameters: Type.Object({}),
			execute: async () => toolResult(store.list().map(describeJob).join("\n\n") || "No jobs yet."),
		});

		pi.registerTool({
			name: "list_projects",
			label: "List projects",
			description: "List the project workspaces a job can be delegated into.",
			parameters: Type.Object({}),
			execute: async () => toolResult(projects().join("\n") || "No projects."),
		});
	};
}
