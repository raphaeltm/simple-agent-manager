# Vendored dgit git core

- Upstream: https://github.com/littledivy/durable-git (npm `durable-git` 0.0.8)
- Commit: `d5eba04eda584b855a1bde1f86a836b751c378c0` (tag v0.0.8, 2026-08-21)
- Licence: MIT, see `LICENSE` in this directory (copyright Divy Srivastava).

## What is here

Local change to every vendored file: two header lines, `// @ts-nocheck` and
`/* eslint-disable */`. Upstream typechecks under `strict` but not SAM's
`noUncheckedIndexedAccess`, and follows its own lint style. Nothing else differs from upstream.

`git/` is upstream `src/git/` copied byte for byte, minus the three modules only the web UI
used (`blame.ts`, `diff.ts`, `snapshot.ts`). Upstream's Worker router (`mod.ts`), registry
Durable Object (`registry.ts`), cgit-style UI (`ui/`) and its `RepoCell` class are not vendored.

SAM's Durable Object, `apps/api/src/durable-objects/hosted-git-repo.ts`, is adapted from
upstream `src/repo.ts` (`RepoCell`): it keeps the smart-HTTP protocol paths (`info/refs`,
`git-upload-pack`, `git-receive-pack`), delete and the GC alarm, and adds SAM's push and
repository caps. Authentication is SAM's (`apps/api/src/services/hosted-git/`), not upstream's.

## Updating

Copy the same files from a newer upstream commit, update the commit above, and run the hosted git
conformance suite (`pnpm --filter @simple-agent-manager/api test:hosted-git`). Do not edit files
under `git/` beyond those two header lines: keep local behaviour in the Durable Object so the next update is a copy.
