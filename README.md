# Crumble

A personal assistant built on [Pi](https://pi.dev/). Crumble is a long-lived Pi agent session that delegates work
to worker agents, each a separate `pi` process in RPC mode. A worker's file and shell tools run inside a sandbox
container; the Pi process itself stays on the host and uses the host's Pi login. A worker that needs a decision asks a
question, is stopped, and is resumed with the answer.

Status: spike. Terminal chat only, one tenant, one coding worker profile.

## Commands

| Command | What it does |
|---|---|
| `pnpm start` | Chat with Crumble in the terminal |
| `pnpm check` | Typecheck |
| `pnpm test` | Unit tests; no network, the worker is faked |
| `pnpm spike` | Live suspend-and-resume test against the real model |
| `pnpm sandbox:build` | Build the `crumble-sandbox` container image |
| `./scripts/make-test-project.sh` | Create the throwaway project `workspaces/demo` |

Each directory under `workspaces/` is a project that a job can be delegated into. Runtime state lives in `data/`.

## Worker runners

`CRUMBLE_RUNNER` selects where a worker's tools act:

- `sandbox` (default): `read`, `write`, `edit` and `bash` run through `docker exec` in one long-lived container per
  project, named `crumble-sandbox-<project>`, with the project mounted at `/workspace`. No model credential enters
  the container.
- `host`: the tools act directly on this machine. The worker is not sandboxed.

The model is set in `src/config.ts`.
