# Crumble

A personal assistant built on Pi. Read `README.md` for what it does and how to run it.

## Lean

Crumble stays small enough that one person can hold it in their head. Every change is weighed against its size.

- Reuse or delete before adding. A change that solves the task with fewer lines wins.
- Add a dependency, file, or abstraction only for a concrete need the existing code cannot meet.
- Do the asked scope. Surface adjacent problems instead of fixing them in passing.

## Architecture

The core stays thin; capabilities plug in at a small set of seams. Put new behaviour behind an existing seam before inventing a new one.

| Seam | Contract | Implementations |
| --- | --- | --- |
| Channel | `src/channels/types.ts` | `src/channels/discord.ts` |
| Worker runner | `WorkerRunner` in `src/runners.ts` | host, sandbox |
| Assistant capability | Pi `ExtensionFactory` | `src/extensions/` |
| Worker tool | Pi extension loaded into the worker | `src/worker/` |
| User plugin | `PluginExecutor` in `src/plugin-executor.ts` | Docker |

Process shape: `main.ts` starts one `TenantHost` per tenant, which forks a tenant process running `TenantAssistant`. Work is delegated to `Supervisor`, which runs each job as a separate Pi RPC worker.

Model requests go through Pi itself. No credential proxies or non-Pi clients.

## Code style

- A class when there is state or a pluggable role; a plain function for stateless helpers.
- One concept per file, named after it. Group files by seam in a folder.
- Persistence lives in SQLite through Drizzle (`src/db/`). Change a schema, then run `pnpm db:generate`.

## Tests

Tests live in `test/`, mirroring `src/` (`src/channels/discord.ts` is tested by `test/channels/discord.test.ts`). Test helpers go in `test/support/`. Source folders hold source only.

## Verify

Run `pnpm check` and `pnpm test` before calling a change done. Tests that need Docker images skip when the image is missing; say so when reporting.
