# Normalize platform error grouping signatures

## Problem

Platform feedback grouping hashes a partially normalized message. Decimal values, short numbers,
quoted values, and structured JSON can therefore make one recurring failure produce a new
signature and a new `Recurring … platform error` draft on each occurrence. The grouping must
normalize volatile data while retaining the stable operation/error shape. Automated triage stays
paused, and this work must not triage, resolve, or close existing drafts.

## Research findings

- `apps/api/src/services/platform-feedback-triage/grouping.ts` currently redacts UUIDs/ULIDs and
  integers with at least three digits, but leaves decimal values, one/two-digit counts, durations,
  ports, timestamps, quoted values, and JSON formatting/content in the hashed key.
- Production read-only inspection of the seven named drafts and their bounded evidence found six
  stable error shapes:
  - `01M3HQVYNR185R39YYTFAJ2B81` (`9cb44a24…`) and
    `01M3HV9TDCD1N2S5BZ7MP97MY1` (`446199b7…`) are the same ProjectData storage warning. Their
    messages differ only at `97.92%` versus `97.99%`; both otherwise read
    `0 bytes/day, time to limit unavailable`. This decimal survived legacy normalization and split
    the group.
  - `01M3BV2XRYTAFBYEH0BH2Z802F` (`08fac197…`) is the max-lifetime deletion error. Five live
    message variants differ only by node ULID (`01M3BB7…`, `01M3BB8…`, `01M3BB9…`,
    `01M3C74…`, `01M3CHFK…`); legacy normalization already collapses these into one signature.
  - `01M3HYR9BGMGGK0PVJTMPWVXH0` (`a3c84131…`) is the stable
    `Destroyed managed node left in destroying handoff` warning and is distinct from the
    max-lifetime deletion failure.
  - `01M22VH54NHRWBWZKXHQ5SFSX9` (`3b8624f0…`) is the stable Hetzner placement failure
    `(412): error during placement`; two current rows differ only by evidence/node IDs and already
    collapse.
  - `01M12RZYJ1W26SNX4WNFC9K5RH` (`24d99190…`) is the snapshot callback-gone response
    (`HTTP 410`, JSON `GONE`, sleeping workspace), while `01M3F8X508A7ZDQAYXFM4145KV`
    (`40abd142…`) is the distinct oversized snapshot response (`HTTP 400`, JSON `BAD_REQUEST`).
    These should remain distinct because their stable error semantics and recovery actions differ.
- Production history contains many storage messages whose percentages, byte rates, and day
  estimates vary independently, confirming that all of those numeric measurements must collapse
  to one stable storage-error signature.
- `platform_feedback_triages.signature` is the primary key. Switching directly to the new hash
  would treat all known legacy groups as new. Add a durable nullable canonical-signature alias and
  resolve a canonical group to an existing legacy row before any insert; preserve the legacy
  primary key and existing Idea linkage.
- The retained Rule 62 lesson requires a mutation check: temporarily restore legacy normalization
  and prove the real-message collapse test fails before restoring the fix.

## Implementation checklist

- [ ] Add focused canonical message normalization for numeric values (including decimals,
      durations, ports, and timestamps), hexadecimal/UUID/ULID identifiers, quoted values, and
      embedded JSON while retaining stable semantic words and source separation.
- [ ] Return enough legacy-signature metadata from grouping to match rows created by the previous
      algorithm.
- [ ] Add an append-only D1 migration and schema field/index for a canonical signature alias.
- [ ] Resolve new canonical groups against either the canonical alias or any legacy signature;
      attach the alias to the selected existing row and preserve its primary key/Idea linkage.
- [ ] Add table-driven tests from the production messages above for collapsing volatile variants,
      plus controls for distinct operation/error shapes and different sources.
- [ ] Add a persistence/runner regression proving an old-signature row is reused and no new Idea is
      created after normalization changes.
- [ ] Perform the Rule 62 mutation check by reverting normalization locally, run the collapse tests
      to red, then restore and rerun green.
- [ ] Keep triage configuration/dispatch unchanged and verify the diff contains no existing-draft
      state mutation.
- [ ] Run focused tests, API/repository quality checks, specialist reviews, staging verification,
      PR/CI/CodeRabbit gates, merge, and production deploy monitoring.

## Acceptance criteria

- Real storage-usage variants with different percentages/counts/durations hash to one signature.
- UUID, ULID, hex, port, timestamp, quoted-value, and embedded-JSON variants normalize without
  leaking volatile values into the grouping key.
- Stable error semantics remain discriminative: max-lifetime deletion, destroying handoff,
  Hetzner placement, snapshot callback-gone, and oversized snapshot errors do not collapse into a
  single group; source remains part of the signature.
- A group previously stored under a legacy signature is matched and updated after deployment;
  normalization rollout does not create a fresh draft for the known error.
- Automated triage remains paused and the seven existing drafts remain untouched.
- Rule 62 red/green mutation evidence, local checks, specialist review, staging, CI, CodeRabbit (if
  it appears), merge, and production deploy evidence are recorded.

## References

- SAM task `01M3J2WD0G0J795T3CMATSQEJA`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `apps/api/.claude/rules/31-migration-safety.md`
- `tasks/archive/2026-07-29-automated-error-store-triage.md`
- `tasks/archive/2026-07-30-platform-feedback-triage-resilience.md`
