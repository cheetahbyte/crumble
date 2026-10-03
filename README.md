# Crumble

A personal assistant built on [Pi](https://pi.dev/). Crumble is a long-lived Pi agent session that delegates work
to worker agents, each a full `pi` process in RPC mode. A worker that needs a decision asks a question, is stopped,
and is resumed with the answer.

Status: spike. Terminal chat only, one tenant, one coding worker profile.

## Commands

| Command | What it does |
|---|---|
| `pnpm start` | Chat with Crumble in the terminal |
| `pnpm check` | Typecheck |
| `pnpm test` | Unit tests; no network, the worker is faked |
| `pnpm spike` | Live suspend-and-resume test against the real model |
| `pnpm worker:build` | Build the `crumble-worker` container image |
| `./scripts/make-test-project.sh` | Create the throwaway project `workspaces/demo` |

Each directory under `workspaces/` is a project that a job can be delegated into. Runtime state lives in `data/`.

## Worker runners

`CRUMBLE_RUNNER` selects where workers run:

- `docker` (default): one container per run, with the project mounted at `/workspace`. Set `CRUMBLE_WORKER_ENV` to a
  comma-separated list of host environment variable names to forward as model credentials, for example `OPENAI_API_KEY`.
- `host`: a plain `pi` process on this machine, using the host's Pi login. The worker is not sandboxed.

The model is set in `src/config.ts`.
