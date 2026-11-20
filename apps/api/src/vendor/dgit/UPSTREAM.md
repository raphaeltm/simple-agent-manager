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

- Ref admission rejects `.lock` suffixes on every path component and a final dot, matching Git check-ref-format; the full rule matrix also retains SAM conservative character and length bounds. The predicate lives in `apps/api/src/lib/git-ref-name.ts` (`isValidGitRefName`), which project creation also uses, so a default branch SAM accepts can always be pushed.

- Push connectivity is proven per command by walking from the new tip until it reaches an existing ref tip, with or without a reachable cache. Each walk collects into a scratch set and joins the trusted set only when its closure is complete, so a failed command cannot vouch for a later one. Upstream's cache-less SQL check (`packComplete`, `push_edges`) is removed: it trusted every object outside the new pack, and SAM keeps a rejected pack's objects until GC.

- Push admission reads no objects to seed the validated set (upstream peeled every ref tip on every push, so a few large tips exhausted the decompression budget for every later push, deletions included), checks the type git requires at every walked edge, refuses non-commits on `refs/heads/*` and directory/file ref conflicts (a ref named by more than one command is refused for all of them, so a deletion that would lose its CAS cannot free a nested name), rejects an unparseable object for its own command only, and memoizes failed walks within a push. Deleting a ref that does not exist succeeds without queueing GC. Pushed commits, tags and trees must have the shape git itself reads, checked on raw bytes (a first line that is exactly `tree <oid>` or `object <oid>`, header order, newline-terminated headers, tag headers, tree modes, and unique names of at most 255 bytes other than `.`, `..`, `.git` and its NTFS forms, with no `.gitmodules` symlink in any of its NTFS forms); an ancestry check that exhausts the work budget counts the update as forced instead of failing the push. Admission never trusts the reachable cache.

- The reachable cache is stamped only with the ref version its clone walk started from, unstamps the cache before rewriting it, and lets only the latest of overlapping saves write or stamp; `commitPush` extends the cache only if it is still stamped current at commit time. A push during a clone walk, a second clone's rewrite, or a push during a rewrite therefore cannot leave a stale or partial set marked current; GC invalidates the cache whenever it deletes objects.

- PackStore adds `packIds`, `packObjectOids` and `dropPack`. Hosted git GC drops whole packs that hold no reachable object and no delta base before it inflates anything, and keeps delta bases only while packs are kept (migration stores reachable objects whole).
