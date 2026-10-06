# Automated admin error-store triage into SAM Ideas

## Problem

PR #1688 shipped a superadmin-only, read-only deployment debugging agent and an
explicit “save diagnosis as draft Idea” flow. Platform errors still require an
admin to select, diagnose, and save each issue manually, so recurring production
failures do not reliably enter SAM's planning loop.

Implement Phase 0 Loop A only: automatically triage bounded groups from
`platform_errors` into a configured SAM project, with the same core path exposed
as a superadmin-only manual trigger for staging verification. Loop B
cross-instance intake, cryptography, R2, and diagnostic bundle upload are out of
scope.

## Research findings

- `apps/api/src/services/debug-agent.ts::runDebugDiagnosis()` is environment-only
  aside from `createdBy` and the selected error/window. It already provides fixed
  read-only tools, boundary redaction, bounded results, metered/atomic token
  reservations, and persisted `debug_diagnoses`.
- The diagnosis service currently hardcodes the interactive
  `deployment-debug-agent` budget/accounting key. Scheduled triage needs a
  distinct feature key while retaining the same reserve/release behavior.
- `apps/api/src/routes/admin.ts` mounts all `/api/admin/*` handlers behind
  `requireAuth()`, `requireApproved()`, and `requireSuperadmin()`. A manual
  trigger on that router inherits the correct boundary, but a mounted-route test
  must prove it.
- `apps/api/src/index.ts::scheduled()` dispatches Cloudflare cron work. The
  existing hourly `30 * * * *` branch currently returns after monthly AI cost
  aggregation, so triage must be explicitly composed without suppressing either
  job.
- `platform_errors` is in the separate observability D1 binding and has no
  signature column. Main D1 therefore needs a durable, unique triage record that
  claims a stable redacted source/signature and tracks bounded window/count,
  diagnosis, and Idea linkage.
- `saveDebugDiagnosisAsIdea()` already attributes the task `userId` to the
  selected project's owner while recording the initiating existing user in
  `createdBy`. Automated triage can safely use the configured project's existing
  owner for both fields; no sentinel user is required.
- Ideas are `tasks` rows with `status='draft'`. Generated content may later reach
  an agent and a public repository, so titles/descriptions must be constructed
  only from redacted, bounded fields and must never embed raw context, stack,
  user ID, IP, user agent, or secret-like values.
- The sibling hosted-report flow shares the
  `PLATFORM_FEEDBACK_PROJECT_ID` contract and untrusted/PII-free provenance
  boundary. This branch must rebase before merge and avoid incompatible
  duplicate helpers.
- Relevant retained lessons: cross-boundary/auth behavior requires tests through
  real route mounting; operational writes must be narrowly scoped to explicitly
  observed records; staging verification must exercise the changed behavior and
  inspect D1 state rather than relying on a superficial response.

## Implementation checklist

- [x] Add shared `DEFAULT_*` limits for triage window, group/error caps, evidence
      bounds, and configurable environment overrides.
- [x] Add and document `PLATFORM_FEEDBACK_PROJECT_ID`; unset/blank must make
      automated/manual triage a safe no-op.
- [x] Add an additive main-D1 migration and Drizzle schema for durable,
      deterministic feedback-triage claims and Idea/diagnosis linkage.
- [x] Refactor `runDebugDiagnosis()` minimally so callers select an allowlisted
      accounting feature key; preserve the existing interactive default and
      atomic reserve/release semantics.
- [x] Implement deterministic grouping from a bounded recent error page using
      redacted/normalized source and message shape plus a time window. Hash only
      the sanitized canonical representation.
- [x] Implement one shared core service for cron and manual triggers. Resolve the
      configured project and existing owner, claim groups idempotently, diagnose
      new groups, and create or update one draft Idea per stable signature.
- [x] Construct Idea provenance from PII-free summaries, bounded error IDs and
      timestamps, counts, source/signature/window metadata, and a redacted
      diagnosis. Never copy raw stack/context/identity/network fields.
- [x] Add the superadmin-only manual endpoint and scheduled cron integration.
- [x] Add disabled-config, mounted-route authorization, deterministic grouping,
      concurrent/repeated dedup, redaction canary, separate-budget, and
      cron/manual-shared-path tests.
- [x] Update environment/deployment references and relevant API documentation.
- [x] Rebase against main/sibling changes and rerun validation before staging.

## Acceptance criteria

- [x] With `PLATFORM_FEEDBACK_PROJECT_ID` unset or blank, triage performs no
      reads that invoke the model and no Idea writes, and reports disabled.
- [x] Both the scheduled handler and a superadmin-only manual endpoint invoke the
      same triage service.
- [x] Non-superadmins cannot invoke the manual endpoint.
- [x] Stable redacted source/signature/window grouping is deterministic and raw
      PII does not influence persisted Idea content.
- [x] Repeated or concurrent matching errors update/annotate the existing draft
      Idea or diagnosis metadata instead of creating unbounded tasks.
- [x] Automated diagnosis usage is charged to a distinct feature key without
      changing the interactive debug-agent budget.
- [x] Canary secrets, authorization material, email/IP/user-agent values, and
      raw user identifiers do not appear in generated Idea title/description.
- [x] Local lint, typecheck, tests, build, migration-safety checks, and all
      required specialist reviews pass.
- [x] Staging deployment is green; a controlled manual tick creates or updates a
      redacted draft Idea with dedup metadata visible in D1/UI.
- [x] PR CI is green and the final PR-head staging deployment completes. Merge
      and matching production-deployment monitoring remain the post-archive
      operational handoff.

## References

- Canonical Idea `01KXN5YQ9TGN29ZZ8DP2DKAKHN`
- PR #1688
- Fable critique task `01KYQVG8FRFXZW6PGWAFZYQVA7`
- `.specify/memory/constitution.md` Principle XI
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/13-staging-verification.md`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/32-cf-api-debugging.md`
