# Feedback Idea metadata hotfix

## Problem

PR #1702 improved feedback Idea prompt-injection boundaries, but Report Issue still renders consented technical refs in `## Trusted Metadata` without validating that their values are safe identifiers. A malicious `refs.errorId` can include Markdown fences, newlines, or instruction-like text that escapes into the trusted metadata zone.

Report Issue redaction also uses a local pattern set that misses bare underscore-form GitHub PATs such as `ghp_...` and `github_pat_...` in submitted titles, descriptions, and consented refs.

## Research Findings

- `apps/api/src/services/report-issue.ts` `validateRefs()` preserves consent gating and authorization checks, but blindly accepts opaque `errorId` and later renders all authorized ref values in `buildIdeaContent()` as trusted Markdown.
- `sanitizeUserInput()` can preserve backticks and newlines, so it is insufficient for values placed outside the untrusted evidence fence.
- `apps/api/src/services/observability.ts` has a reusable `redactSensitiveData()` helper with stronger PAT redaction than the local Report Issue helper, but it does not yet cover bare `ghp_...` tokens shorter than GitHub's current full token length.
- `apps/api/src/services/platform-feedback-triage.ts` currently pins `group.summary` to `Recurring <source> platform error`; this is safe outside the fence only if it remains attacker-independent.
- `tasks/active/2026-07-30-harden-feedback-idea-boundaries.md` remains active on main with validation/review/PR items unchecked even though PR #1702 merged.

## Implementation Checklist

- [x] Add a small safe-identifier validator for Report Issue technical refs rendered as trusted metadata.
- [x] Apply the validator after consent/authorization so invalid refs are silently dropped without weakening existing access checks.
- [x] Reuse or align Report Issue redaction with the observability secret redaction patterns and cover bare `ghp_...` plus `github_pat_...`.
- [x] Add focused Report Issue tests for malicious `errorId`/technical refs with backticks, newlines, and prompt-injection text.
- [x] Add focused Report Issue tests for bare GitHub PAT redaction in titles, descriptions, and consented refs.
- [x] Add a platform feedback triage regression test proving `group.summary` stays `Recurring <source> platform error` and attacker text cannot enter Trusted Metadata summary.
- [x] Add a concise maintainer-facing note that user-submitted report titles are external/untrusted too.
- [x] Archive or update the stale #1702 task record so it no longer appears active with unchecked completion gates.
- [x] Run targeted tests and proportional lint/typecheck/test/build validation.
- [x] Run `security-auditor` and `task-completion-validator` reviews and record evidence.
- [x] Deploy to staging and verify changed behavior. PR merge and production deploy monitoring continue in the hotfix PR workflow.

## Acceptance Criteria

- Malicious Report Issue technical refs containing Markdown fences, backticks, newlines, or prompt-injection prose do not appear in Trusted Metadata.
- Consent-gated refs remain gated; unauthorized refs remain silently dropped.
- Bare GitHub PATs `ghp_...` and `github_pat_...` are redacted from stored Report Issue titles, descriptions, and consented refs.
- Platform feedback `Summary:` trusted metadata remains derived from the pinned `Recurring <source> platform error` template.
- User-submitted report titles are marked as external/untrusted or otherwise prevented from acting as trusted instructions.
- The stale #1702 task record is archived/updated appropriately.

## Closure Note

Archived after implementation and staging verification. Validation evidence:

- Targeted report/platform tests passed: `pnpm vitest run apps/api/tests/unit/report-issue.test.ts apps/api/tests/unit/services/platform-feedback-triage.test.ts`
- API lint/typecheck passed, full build/typecheck/lint passed, and full test suite had one unrelated timing-flaky `local-forward-token` assertion that passed on focused rerun.
- Specialist reviews completed: `security-auditor` PASS and `task-completion-validator` PASS.
- Staging deploy passed: GitHub Actions run `30510169078`, including smoke tests.
- Targeted staging report verification created Idea `01KYRGPA496PHHGXVV2HFFEG10`; stored data redacted bare `ghp_...` and `github_pat_...`, dropped malicious refs from Trusted Metadata, and included the title-untrusted note.
