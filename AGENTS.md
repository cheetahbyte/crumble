# Crumble

A personal assistant built on Pi. Read `README.md` for what it does and how to run it.

## Lean

Crumble stays small enough that one person can hold it in their head. Every change is weighed against its size.

- Reuse or delete before adding. A change that solves the task with fewer lines wins.
- Add a dependency, file, or abstraction only for a concrete need the existing code cannot meet.
- Do the asked scope. Surface adjacent problems instead of fixing them in passing.

## Architecture

Crumble is a modular monolith. Read `docs/modules.md` before adding a module, moving code between modules, or touching a table.

- A module is a folder under `src/`. Its public surface is the file named after it (`src/jobs/jobs.ts`) plus its Pi extension (`extension.ts`). Other modules import only those two files.
- A module owns its tables. Only its own classes read or write them.
- Dependencies point one way, in the order listed in `docs/modules.md`. `main.ts` and `host/tenant-process.ts` wire modules together.
- `src/shared/` holds helpers with no domain knowledge and imports no module.

Capabilities plug in at these seams. Put new behaviour behind an existing seam before inventing a new one.

| Seam | Contract | Implementations |
| --- | --- | --- |
| Channel | `Channel` in `src/channels/channels.ts` | `DiscordChannel` |
| Worker runner | `WorkerRunner` in `src/jobs/runner.ts` | `HostRunner`, `SandboxRunner` |
| Assistant capability | Pi `ExtensionFactory` in `<module>/extension.ts` | one per module |
| Worker tool | Pi extension loaded into the worker | `src/jobs/worker/` |
| User plugin | `PluginExecutor` in `src/plugins/executor.ts` | Docker |

Model requests go through Pi itself. No credential proxies or non-Pi clients.

## Runtime

Crumble runs on Bun and uses Node built-ins (`node:sqlite`, `node:child_process`, `node:test`) through Bun's compatibility layer. Bun loads `.env` from the working directory by default, so every Bun process Crumble starts passes `--no-env-file`: the tenant `fork` in `src/host/host.ts` and Pi workers through `piCliArgs` in `src/shared/pi-command.ts`.

## Code style

- A class when there is state or a pluggable role; a plain function for stateless helpers.
- One concept per file, named after it.
- Persistence lives in SQLite through Drizzle (`src/db/`). Change a schema, then run `bun run db:generate`.

## Tests

Tests live in `test/`, mirroring `src/` (`src/channels/discord.ts` is tested by `test/channels/discord.test.ts`). Tests that span modules sit at the `test/` root. Test helpers go in `test/support/`. Source folders hold source only.

## Verify

Run `bun run check` and `bun run test` before calling a change done. Use `bun run test`, not bare `bun test`: the script limits discovery to `test/` and skips `.env`. Tests that need Docker images skip when the image is missing; say so when reporting.
