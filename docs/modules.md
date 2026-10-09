# Modules

Crumble is a modular monolith: one service, one tenant database, and a folder per module under `src/`. The rules live in `AGENTS.md`; this file maps the modules.

## Map

Listed from the bottom of the dependency graph to the top. A module imports only modules above it in this list.

| Module | Public file | Owns tables | Role |
| --- | --- | --- | --- |
| `shared` | any file | none | Helpers with no domain knowledge: paths, secrets, text checks, tool results |
| `db` | `database.ts` | schema files | Opens and migrates tenant databases |
| `mcp` | `mcp.ts` | none | MCP server config, secret forwarding, and sandbox wrapping for local servers |
| `tenants` | `tenants.ts` | none | Tenant config and directories |
| `config` | `config.ts` | none | Loads `crumble.config.json` |
| `auth` | `auth.ts` | none | Model login per tenant |
| `channels` | `channels.ts` | none | `Channel` seam; `DiscordChannel` |
| `browser` | `browser.ts` | none | Sandboxed browser per tenant |
| `plugins` | `plugins.ts` | `plugins` | User-built executable plugins |
| `memory` | `memory.ts` | `assistant_memory*` | Stable preferences and facts with revisions |
| `learning` | `learning.ts` | `learning_*` | Conversation history search and learned procedures |
| `inbox` | `inbox.ts` | `assistant_inbox`, `assistant_deliveries` | Request queue, reply outbox, one-turn-at-a-time processor |
| `routines` | `routines.ts` | `assistant_schedules` | Scheduled prompts; enqueue through the inbox |
| `jobs` | `jobs.ts` | `jobs`, `job_notifications` | Background workers: store, supervisor, `WorkerRunner` seam, worker tools |
| `assistant` | `assistant.ts` | none | `TenantAssistant`: the Pi session and chat commands |
| `host` | `host.ts` | none | Tenant process lifecycle and reply delivery |

`main.ts` and `host/tenant-process.ts` are the composition roots.

## Couplings to know

- **Inbox to learning history.** SQL triggers in `drizzle/assistant/20261005042934_learning_and_memory_history` copy finished `assistant_inbox` rows into `learning_history`. Learning reads that projection; it never writes the inbox.
- **Inbox to routines.** A request carries an optional `schedule_id`. `Routines` registers itself as the inbox's delivery policy in its constructor, so a finished scheduled run records its result and applies `changes_only` inside the inbox's completion transaction.
- **Memory table names.** Memory tables keep their historical `assistant_memory*` names. Renaming them needs a migration.
