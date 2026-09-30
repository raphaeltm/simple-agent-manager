# Repo History Bloat: Purge Accidentally-Committed Agent State + Add Size Guard

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:**
>   - `.codex/*` and the `packages/vm-agent/vm-agent` binary are gitignored (`.gitignore:19,63`;
>     `.codex/` untracked by PR #1622), so the auto-commit's `git add -A`
>     (`packages/vm-agent/internal/server/server.go:1700`) no longer stages them.
>   - CI rejects a tracked vm-agent binary: `pnpm quality:no-tracked-stale-binaries`
>     (`scripts/quality/check-no-tracked-stale-binaries.ts`, `.github/workflows/ci.yml:160`;
>     PR #1712, 65d67abf8).
> - **Still open:**
>   - Raphaël's decision on the history rewrite. History still holds 41 object entries for
>     `.codex/logs_2.sqlite` (the local pack is about 630 MiB), and no knowledge entry or idea
>     records a decision.
>   - A size-based large-blob CI guard. None exists; `quality:file-sizes` counts lines, not bytes.

## Problem

The repository's pack size tripled to **371 MiB** on 2026-07-17/18. "chore: save agent work" auto-commits pushed `.codex/` runtime state directly to `main`: 17 copies of a ~10–12 MB SQLite log (`.codex/logs_2.sqlite`), multiple ~6 MB WAL files, ~7 MB plugin catalog JSONs, a 7 MB `.pptx` template asset, and two compiled `packages/vm-agent/vm-agent` binaries (18.4 MB + 9.3 MB). Blobs >2 MB in history total **413 MB**. PR #1622 (2026-07-17) stopped tracking `.codex/` but did not (and cannot, without history rewrite) remove the blobs from history.

This bloat broke all production instant-container sessions (full clone crossed the 30s create-workspace timeout — see `tasks/archive/2026-07-19-fix-instant-container-clone-timeout.md`), and it permanently slows every clone/fetch/CI checkout until history is rewritten.

## Proposed Work (needs explicit human sign-off — history rewrite is destructive)

1. **Decision (Raphaël)**: rewrite `main` history with `git filter-repo` (or BFG) to strip `.codex/**`, `packages/vm-agent/vm-agent`, and blobs > ~5 MB that are not intentional assets. Requires a coordinated force-push, re-clone by all agents/workspaces, and invalidates open PR bases. GitHub support may need to run GC to actually shrink the server pack.
2. **Guard rails (no sign-off needed, can ship anytime)**:
   - [ ] Pre-push/CI check that rejects blobs over a configurable size (e.g. 2 MB) outside an allowlist (fonts, og-images).
   - [ ] Fix the "chore: save agent work" auto-commit path to respect gitignore semantics before staging (it committed `.codex/` state that was meant to be untracked) and to never commit compiled binaries (`packages/vm-agent/vm-agent`).
3. **Not in scope**: the instant-session partial-clone fix already shipped separately and removes the operational urgency.

## Acceptance Criteria

- [ ] Raphaël has explicitly decided for/against the history rewrite (do NOT execute without sign-off)
- [ ] Large-blob CI guard in place and green on main
- [ ] Auto-commit path can no longer commit ignored runtime state or build artifacts
