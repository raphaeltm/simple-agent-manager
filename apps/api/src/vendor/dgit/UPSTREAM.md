# Vendored dgit git core

- Upstream: https://github.com/littledivy/durable-git (npm `durable-git` 0.0.8)
- Commit: `d5eba04eda584b855a1bde1f86a836b751c378c0` (tag v0.0.8, 2026-08-21)
- Licence: MIT, see `LICENSE` in this directory (copyright Divy Srivastava).

## What is here

Vendored files carry `/* eslint-disable */` and `// @ts-nocheck` headers. Upstream typechecks under `strict` but not SAM's
`noUncheckedIndexedAccess`, and follows its own lint style. `protocol.ts` and `packstore.ts` also
carry a `// FILE SIZE EXCEPTION` line. SAM security adaptations are listed below.

`git/` is adapted from upstream `src/git/`, minus the three modules only the web UI
used (`blame.ts`, `diff.ts`, `snapshot.ts`). Upstream's Worker router (`mod.ts`), registry
Durable Object (`registry.ts`), cgit-style UI (`ui/`) and its `RepoCell` class are not vendored.

Only the self-host build contains this code; the Cloudflare Worker's entry never imports it (see
`apps/api/src/selfhost/hosted-git.ts`).

SAM's Durable Object, `apps/api/src/selfhost/hosted-git/hosted-git-repo.ts`, is adapted from
upstream `src/repo.ts` (`RepoCell`): it keeps the smart-HTTP protocol paths (`info/refs`,
`git-upload-pack`, `git-receive-pack`), delete and the GC alarm, and adds SAM's push and
repository caps. Authentication is SAM's (`apps/api/src/selfhost/hosted-git/`), not upstream's.

## Updating

Copy the same files from a newer upstream commit, update the commit above, and run the hosted git
conformance suite (`pnpm --filter @simple-agent-manager/api test:hosted-git`). Preserve and reapply the SAM resource policy and SQL safety changes below; an upstream copy alone would remove these protections. Keep repository authentication and lifecycle policy in the self-host adapter.

## H2 resource policy

SAM adds `git/budget.ts` around pack ingest, reads and delta application. Every request and GC invocation carries a separate cumulative decompression and deadline budget, including streamed responses. Object size is checked before allocation and while inflating, delta targets before allocation, and delta depth before traversal. Policy values come from the optional repository backend's typed admin settings. These are deliberate security changes to the vendored code; this directory is not byte-for-byte upstream.

SQL identifiers use static allowlisted statements, and variable-sized bind lists are split below the runtime parameter ceiling. The additional GC admission and response accounting checks are covered by the hosted git suite.

- PackStore exposes its existing incomplete-pack sweep as `cleanupOrphans`, so failed uploads can reclaim quota immediately and GC can retry storage cleanup independently of another admitted push.

- Ref admission rejects `.lock` suffixes on every path component and a final dot, matching Git check-ref-format; the full rule matrix also retains SAM conservative character and length bounds.
