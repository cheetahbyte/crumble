import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { InboundRequest } from "#inbox";
import { toolResult } from "#shared/tool-result";
import type { Routines, ScheduleUpdate } from "./routines.ts";

export function routinesExtension(options: {
	routines: Routines;
	timezone: string;
	currentRequest: () => InboundRequest | undefined;
	setOutcome: (outcome: { text: string; notify: boolean }) => void;
}): ExtensionFactory {
	const { routines, timezone, currentRequest, setOutcome } = options;
	return (pi) => {
		pi.on("before_agent_start", async (event) => {
			const request = currentRequest();
			const schedule = request?.scheduleId ? routines.getSchedule(request.scheduleId) : undefined;
			if (!schedule) return;
			const prior = schedule.lastResult === null ? "No prior result is available." : schedule.lastResult.slice(0, 8_000);
			event.systemPromptOptions.sections.routine =
				`Scheduled routine: ${schedule.label}\nRoutine prompt: ${schedule.prompt.slice(0, 8_000)}\n` +
				`Prior run result: ${prior}\n` +
				"Perform the authorized routine check now, using the prior result to identify meaningful changes. Complete the check before replying. " +
				"For changes_only routines, use report_routine_result to return the concise current result and indicate whether it contains a meaningful change; unchanged checks should stay quiet. " +
				"A separately emitted worker update cannot be silenced by this routine outcome, so prefer completing checks directly when possible.";
		});

		pi.registerTool({
			name: "schedule", label: "Schedule routine",
			description: "Create a private routine that runs an assistant prompt once, at a fixed elapsed interval, or on a timezone-aware cron schedule. Cron schedules use local wall-clock time and skip missed occurrences when the assistant is offline. notification_policy can be always or changes_only.",
			parameters: Type.Object({
				label: Type.String({ maxLength: 256 }),
				prompt: Type.String({ maxLength: 32_000 }),
				due_at: Type.Optional(Type.String()),
				repeat_every_minutes: Type.Optional(Type.Number({ minimum: 1 })),
				cron: Type.Optional(Type.String()),
				timezone: Type.Optional(Type.String()),
				notification_policy: Type.Optional(Type.Union([Type.Literal("always"), Type.Literal("changes_only")])),
			}),
			execute: async (_id, p) => toolResult(routines.createSchedule({
				label: p.label,
				prompt: p.prompt,
				dueAt: p.due_at,
				intervalMs: p.repeat_every_minutes === undefined ? undefined : p.repeat_every_minutes * 60_000,
				cron: p.cron,
				timezone: p.timezone ?? timezone,
				notificationPolicy: p.notification_policy,
				source: currentRequest()?.source ?? "internal",
			})),
		});

		pi.registerTool({
			name: "list_schedules", label: "List routines",
			description: "List saved routines, their next run, timezone, notification policy, pause state, and latest result.",
			parameters: Type.Object({}),
			execute: async () => toolResult(routines.listSchedules()),
		});

		pi.registerTool({
			name: "cancel_schedule", label: "Cancel routine",
			description: "Disable a saved routine so it will not run again. An already queued run is unaffected.",
			parameters: Type.Object({ id: Type.String() }),
			execute: async (_id, p) => toolResult(routines.cancelSchedule(p.id) ? "Routine cancelled." : "No active routine with that ID."),
		});

		pi.registerTool({
			name: "manage_schedule", label: "Manage routine",
			description: "Pause or resume a routine, update its prompt or schedule, or queue it to run now. Updating cron clears a fixed interval and vice versa.",
			parameters: Type.Object({
				action: Type.Union([Type.Literal("pause"), Type.Literal("resume"), Type.Literal("update"), Type.Literal("run_now")]),
				id: Type.String(),
				label: Type.Optional(Type.String({ maxLength: 256 })),
				prompt: Type.Optional(Type.String({ maxLength: 32_000 })),
				due_at: Type.Optional(Type.String()),
				repeat_every_minutes: Type.Optional(Type.Number({ minimum: 1 })),
				cron: Type.Optional(Type.String()),
				timezone: Type.Optional(Type.String()),
				notification_policy: Type.Optional(Type.Union([Type.Literal("always"), Type.Literal("changes_only")])),
			}),
			execute: async (_id, p) => {
				if (p.action === "pause") return toolResult(routines.pauseSchedule(p.id) ? "Routine paused." : "Routine was not active or was already paused.");
				if (p.action === "resume") return toolResult(routines.resumeSchedule(p.id) ? "Routine resumed." : "Routine was not active or was already running.");
				if (p.action === "run_now") return toolResult(routines.runScheduleNow(p.id) ? "Routine queued to run now." : "Routine is unavailable or already queued/running.");
				const update: ScheduleUpdate = {
					label: p.label,
					prompt: p.prompt,
					dueAt: p.due_at,
					cron: p.cron,
					timezone: p.timezone,
					notificationPolicy: p.notification_policy,
				};
				if (p.repeat_every_minutes !== undefined) update.intervalMs = p.repeat_every_minutes * 60_000;
				if (p.cron !== undefined && p.repeat_every_minutes === undefined) update.intervalMs = null;
				if (p.repeat_every_minutes !== undefined && p.cron === undefined) update.cron = null;
				return toolResult(routines.updateSchedule(p.id, update) ?? "No active routine with that ID.");
			},
		});

		pi.registerTool({
			name: "report_routine_result", label: "Report routine result",
			description: "Return the result of the current scheduled routine. For a changes_only routine, set changed=false when the check found no meaningful change; its response will be saved without a notification. This tool has no quieting effect on ordinary requests or always-notify routines.",
			parameters: Type.Object({ text: Type.String({ maxLength: 32_000 }), changed: Type.Boolean() }),
			execute: async (_id, p) => {
				const request = currentRequest();
				const schedule = request?.scheduleId ? routines.getSchedule(request.scheduleId) : undefined;
				if (!schedule) throw new Error("report_routine_result is only available during a scheduled routine run.");
				const quietable = schedule.notificationPolicy === "changes_only";
				setOutcome({ text: p.text, notify: quietable ? p.changed : true });
				return toolResult(quietable && !p.changed ? "Routine result saved; no notification will be sent." : "Routine result saved for delivery.");
			},
		});
	};
}
