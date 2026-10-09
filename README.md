# Crumble

Crumble is a personal assistant built on Pi. It runs as one headless service and accepts requests through Discord direct messages. It keeps private state for each configured person and delegates project work to background workers. You can teach it preferences, schedule prompts, and ask it to build executable capabilities as your needs change.

The assistant handles conversation and coordination. A worker performs file and shell tasks in a private workspace. The service manages isolated tenant processes and headless Pi RPC workers; none launches a terminal UI. By default, Docker runs the worker's file and shell tools. The Pi process runs on the host with that tenant's Pi configuration.

## Requirements

- Node.js 24 or later
- pnpm
- Docker, when you use the default `sandbox` runner
- A model provider configured through Pi for each tenant
- A Discord bot token when you want Discord access

## Install Crumble

1. Install dependencies:

   ```sh
   pnpm install
   ```

2. Build the worker container image:

   ```sh
   pnpm sandbox:build
   pnpm browser:build
   ```

3. Create `crumble.config.json` in the repository root when you want multiple tenants, Discord, or custom settings. The file must list every tenant explicitly. Replace `DISCORD_USER_ID` and `PARTNER_DISCORD_USER_ID` with Discord user IDs. Each value must be a Discord snowflake.

   ```json
   {
     "dataDir": "data",
     "provider": "openai",
     "model": "gpt-6-luna",
     "runner": "sandbox",
     "tenants": [
       {
         "id": "alex",
         "discordUserId": "DISCORD_USER_ID",
         "timezone": "Europe/Berlin"
       },
       {
         "id": "partner",
         "discordUserId": "PARTNER_DISCORD_USER_ID",
         "timezone": "Europe/Berlin"
       }
     ]
   }
   ```

4. Keep `crumble.config.json` on your machine. Do not commit it. It contains account mappings and local settings. The Discord bot token belongs in `DISCORD_TOKEN`, not in the configuration file.

5. Set up model authentication separately for every tenant. Replace `TENANT_ID` with a configured tenant ID. The command runs an authentication-only flow for that tenant. It does not start Pi's coding agent or terminal UI:

   ```sh
   pnpm auth --tenant TENANT_ID
   ```

   Authentication uses Pi's provider API directly. OAuth is preferred when available; use `--method api_key` to choose API-key login. The setup command exits when login completes. Only the service needs to remain running.

6. Copy `.env.example` to `.env` and set `DISCORD_TOKEN` locally, or supply it through your service environment. Start and service commands load `.env` automatically. The token authenticates the bot; `discordUserId` maps one person's direct messages to their tenant.

   ```sh
   export DISCORD_TOKEN
   ```

   Set the variable using your shell or secret manager. Do not put the token in `crumble.config.json` or commit it.

7. Start the service:

   ```sh
   pnpm start
   ```

   This runs Discord, schedules, saved request queues, tenant assistants, and background workers. There is no terminal chat or Pi TUI. `pnpm service` is an alias for the same service. Run only one instance per data directory. Use Ctrl+C or SIGTERM for a clean shutdown.

   Without Discord credentials, the service still processes saved requests and schedules. Replies remain queued until their channel is available. `pnpm run doctor` checks Docker, the sandbox image, account mappings, and each tenant's model authentication without printing credentials.

## Configure tenants

Each tenant has a lowercase ID and private runtime directories under `data/tenants/<TENANT_ID>/`. The directories hold that person's Pi configuration, memory, request history, worker jobs, workspaces, and plugin data. Replace `TENANT_ID` with the configured tenant ID.

Discord uses the exact `discordUserId` mapping. Crumble ignores guild messages, group direct messages, bot messages, and messages from unmapped accounts.

Each tenant can set its own `provider`, `model`, and IANA `timezone`. Top-level values provide defaults. `dataDir` is relative to the configuration file. Without a configuration file, Crumble enables one private `default` tenant.

Use the `sandbox` runner when you configure more than one tenant. The `host` runner runs worker tools directly on the machine and is limited to one tenant.

Each tenant's sandboxes share one persistent home directory, stored on the host at `DATA_DIR/tenants/TENANT_ID/sandbox-home` and mounted at `/root`. Tools installed there (`npm install -g`, `pip install --user`, or binaries in `~/.local/bin`) and logins stored there survive container restarts and are available in every project. Everything else in a container outside `~` and `/workspace` is reset when Crumble recreates it. Anything that runs in the sandbox can read this directory, including stored tokens, so use credentials you can revoke.

To let workers use Claude Code, ask Crumble to install it (`npm install -g @anthropic-ai/claude-code`). Then sign in once from a running sandbox container of that tenant: find it with `docker ps --filter name=crumble-sandbox-TENANT_ID`, run `docker exec -it CONTAINER_NAME claude`, and complete the login. The login is stored in the shared home directory.

## Use Crumble

Send a request in a Discord direct message. Crumble handles ordinary conversation and delegates work that needs research, code, files, shell commands, or a new capability.

Workers run in the background. Crumble tells you when a worker finishes, fails, or needs a decision. A worker that asks a question waits for your answer. You can continue or retry interrupted work explicitly; Crumble does not replay interrupted requests automatically.

Ask in plain language to list, cancel, pause, forget, or roll back things. Crumble does not advertise commands in chat. For recovery when the model is unavailable or a turn hangs, these hidden commands bypass the model:

| Command | Action |
| --- | --- |
| `/jobs` | List delegated jobs and their states. |
| `/cancel JOB_ID` | Request cancellation of a worker job. Replace `JOB_ID` with the job ID. |
| `/plugins` | List installed capabilities and their states. |
| `/plugin disable PLUGIN_NAME` | Disable a capability. Replace `PLUGIN_NAME` with its name. |
| `/plugin enable PLUGIN_NAME` | Enable a capability. Replace `PLUGIN_NAME` with its name. |
| `/plugin rollback PLUGIN_NAME` | Restore the previous capability version. Replace `PLUGIN_NAME` with its name. |
| `/schedules` | List routines, schedules, and their latest result. |
| `/routine pause\|resume\|run ID` | Pause, resume, or run a routine now. |
| `/history QUERY` | Search earlier private conversations. |
| `/skills` | List learned procedures. |
| `/skill show\|history\|delete\|disable\|enable\|rollback NAME` | Inspect or manage a learned procedure and its revisions. |
| `/memories` | List saved preferences and facts. |
| `/memory show\|history\|rollback\|forget KEY` | Inspect, undo, or remove a memory and its revisions. |
| `/learning on\|off` | Turn automatic learning on or off for this tenant. |
| `/stop` or `stop` | Stop the current assistant turn. Worker jobs continue until cancelled separately. |

The assistant can also manage jobs, memory, schedules, workspaces, and plugins through its tools. Schedules can run once, repeat at a fixed elapsed interval, or follow a timezone-aware cron expression. Routines can be paused, resumed, edited, or run on demand. Quiet monitors retain their last result and can suppress unchanged updates; failures are still reported. Quiet checks run browser or plugin tools directly, because background workers report independently. External webhook/event triggers are not included. Crumble does not include a built-in email provider.

## Recall, learned procedures, and browser work

Ask about earlier conversations to search your private history. Crumble can retrieve dated excerpts and load the original exchange instead of guessing from the current context window. Preference memory stays separate from transcript search.

Crumble learns while it replies, with the full conversation in view. When you state a stable preference, correct how it did something, or a task succeeds with an approach worth reusing, it saves a memory or a learned procedure and ends its reply with a short line such as "Noted: you prefer short replies." There is no separate review step or extra model call. Scheduled runs and internal worker notifications do not save anything on their own.

Ask Crumble to stop learning, or use `/learning off`; it then saves memories and procedures only when you ask. Memory revisions retain the reason for a change, and skill revisions retain the source request and reason. Identical saves do not create new revisions. Forgetting a memory removes its saved revisions, and deleting a skill removes all its versions; conversation history is separate and remains searchable.

Ask Crumble to save a successful workflow as a learned skill. Skills are reusable instructions, with relevant descriptions selected by lexical search for the current request and loaded into the assistant's context and full procedures loaded when relevant. They can be edited, disabled, enabled, or rolled back. They do not execute host extensions or grant new access.

The browser tool opens websites, reads page content, clicks controls, fills fields, presses keys, and takes screenshots for the assistant. Each tenant gets a private Docker browser with a persistent Chromium profile. Cookies and site state are private to that tenant. Login challenges and CAPTCHAs still need human intervention; there is no remote desktop takeover UI. Browser content is treated as untrusted data.

Example requests:

- “Find what we decided about the deployment last week.”
- “Save the procedure we just verified so you can use it next time.”
- “Open this website and compare the information on these two pages.”
- “Every weekday at 9am Berlin time, check this page and tell me only if something important changed.”

The research and scope decisions are in [the Grok Bot/Hermes comparison](docs/research/grokbot-hermes-features.md).

## Create a capability

Ask Crumble to build a capability for a concrete task. It can delegate the implementation to a worker, test it in the tenant's `capabilities` workspace, and install it after validation.

A capability source directory contains a `plugin.json` manifest and a JavaScript entry point. The manifest names the capability, describes it, selects its entry file, and can provide usage instructions. For example:

```json
{
  "name": "example-capability",
  "description": "Converts a short text into a title.",
  "instructions": "Provide the text as JSON input and return one concise title.",
  "entry": "index.js"
}
```

The entry point reads one JSON value from standard input and writes its text result to standard output. Crumble invokes it through `run_plugin`. Each invocation runs in a fresh Docker container. The plugin source is mounted read-only; its tenant-specific `/data` directory persists between invocations. The container receives no host environment or model credentials. A failed invocation disables the capability; ordinary cancellation leaves it enabled. Inspect failures before enabling a capability again. Rollback restores code and instructions, not mutations already made to `/data` or external services.

Installed capabilities have versioned snapshots. Use `/plugin disable PLUGIN_NAME` to stop a capability, or `/plugin rollback PLUGIN_NAME` to restore its previous version. Set `CRUMBLE_DISABLE_PLUGINS=1` to start in safe mode with all capabilities disabled.

The plugin system currently covers executable tools and instructions. It does not yet let plugins replace core message routing, lifecycle handling, or channel adapters. Pi's arbitrary host extensions are disabled in Crumble's host process.

## Understand persistence and recovery

Pi's SDK maintains a persistent assistant session for each tenant and restores its conversation on restart. Worker jobs also resume their own saved Pi sessions when explicitly continued. The service owns these sessions; no separate interactive agent needs to stay open.

Crumble stores each tenant's memory, inbox, outbox, schedules, and plugin registry in SQLite. Plugin code snapshots and plugin data stay on disk under the tenant's `plugins` directory; an existing `plugins.json` registry is imported once and kept as `plugins.json.imported`. It also stores worker jobs and completion notifications in SQLite. This lets it deliver queued responses and job updates after a temporary channel outage.

Discord delivery is retried until acknowledged locally. If the process fails between a successful send and its acknowledgment, or after sending part of a long reply, a retry can duplicate messages. This is not exactly-once delivery.

If the process stops during an assistant request, Crumble records the request as interrupted and does not replay it. A job interrupted while its worker was running also requires an explicit retry. This avoids repeating side effects without your direction.

Tenant databases migrate automatically when opened. Drizzle schemas in `src/db/assistant-schema.ts` and `src/db/jobs-schema.ts` define the tables, indexes, and constraints. Checked-in SQL migrations live under `drizzle/assistant/` and `drizzle/jobs/`. Existing tenant databases are adopted transactionally, preserving rows and applying the same constraints as new databases. An invalid legacy row causes adoption to roll back and startup to fail with the database error.

To change a schema, edit its TypeScript definition, run `pnpm db:generate`, review the generated SQL, and commit the migration and snapshot together. Use `drizzle-kit generate --config=drizzle.assistant.config.ts --custom --name=CHANGE_NAME` for data backfills, SQLite FTS tables, and triggers. Test both fresh databases and upgrades. Keep applied migrations unchanged; add another migration for subsequent changes. `pnpm db:check` checks migration history consistency.

The ORM and Kit are pinned to matching `1.0.0-rc.4` releases because the `node:sqlite` adapter is not in Drizzle's stable release yet. Database row types are inferred from the schemas; existing SQL queries continue to use the built-in driver.

Data ownership from the earlier spike is not migrated automatically. Stop Crumble and back up the old data before moving it into a tenant directory. Move it manually only when you know which tenant owns it.

## Run checks

Run the unit tests and TypeScript check:

```sh
pnpm test
pnpm check
pnpm db:check
```

The tests use fake Discord clients and workers, plus real local process tests. They do not log in to Discord or contact a live model. A sandbox cancellation test uses Docker when the image is available and skips otherwise. `pnpm spike` runs a separate live model suspend-and-resume experiment in the selected tenant; create its throwaway workspace with `./scripts/make-test-project.sh` first.

Worker shell commands terminate their ordinary background process group when they finish or are cancelled. A host crash or an unreachable Docker daemon can prevent immediate cleanup; the in-container command timeout provides a fallback. A deliberately detached process can escape process-group cleanup. Containers currently persist per tenant workspace, so this is not a per-job container kill boundary.
