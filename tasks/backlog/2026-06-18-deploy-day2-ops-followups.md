# Day-2 deploy ops follow-ups (deferred from PR #1313)

## Context

Deferred MEDIUM/LOW findings from the PR #1313 (`app-deployment-day2`)
specialist review on 2026-06-18. The one merge-blocking HIGH finding — a data
race on `Engine` callback token (heartbeat writer vs. apply reader) — was fixed
in-branch before merge (dedicated `tokenMu`-guarded `callbackToken` field +
`getCallbackToken()` accessor + `TestEngine_CallbackTokenRotation_ThreadSafe`
race regression test). These remaining items are genuine but non-blocking
hardening captured per rule 42 so they are not lost.

## Problem

The day-2 operations layer (status model, image GC, log rotation) shipped with
several robustness and config-hygiene gaps that do not block the MVP but should
be tightened.

## Acceptance Criteria

- [ ] **Image GC must not delete in-use `<none>:latest` / digest refs (MEDIUM).**
      The image garbage collector can target dangling/untagged references that a
      running compose project still depends on. Cross-check candidates against
      images referenced by active containers (`docker ps` / compose project
      images) before removal, and skip any in-use ref. Add a test that seeds an
      in-use untagged image and asserts GC leaves it.
- [ ] **`collectProtectedImages` must not silently continue on error (MEDIUM).**
      The protected-image collection path swallows enumeration errors and
      continues, which can let GC proceed with an incomplete protection set and
      delete a needed image. Treat an enumeration failure as fatal-to-GC (abort
      this GC pass and log), rather than continuing with a partial set. Add a
      test that injects an enumeration error and asserts GC aborts.
- [ ] **Log-rotation `max-size`/`max-file` must be env-configurable (MEDIUM,
      Principle XI).** The hardcoded `'10m'` / `'3'` Docker log-rotation values
      violate constitution Principle XI. Introduce
      `DEPLOY_LOG_MAX_SIZE` (default `10m`) and `DEPLOY_LOG_MAX_FILE`
      (default `3`) with documented defaults, wired through the compose
      generation path.
- [ ] **Remove dead `ComposeCmd` field (LOW).** If `ComposeCmd` on the engine
      config is no longer referenced after the day-2 changes, delete it
      (rule: no dead code). Verify with a usage grep before removal.
- [ ] **`writeFileAtomic` should fsync before rename (LOW).** The atomic-write
      helper renames a temp file into place without fsync'ing the file (and
      ideally the parent dir), so a crash between write and rename-flush can
      leave a zero-length or truncated state file. Add `f.Sync()` before close
      and (best-effort) a dir fsync after rename.
- [ ] **Validate log-rotation field formats (LOW).** Add format validation for
      the log-rotation size/count inputs (size matches `^\d+[kmg]?$`, count is a
      positive integer) so a malformed value fails fast at config time rather
      than producing an invalid compose file.

## References

- PR #1313 go-specialist + test-engineer review rows
- rule 42 (track deferred behavior-degrading placeholders / follow-ups)
- rule 03 / constitution Principle XI (no hardcoded values)
- Companion: `tasks/backlog/2026-06-17-deploy-engine-security-hardening-followups.md` (PR #1312 deferred items)
