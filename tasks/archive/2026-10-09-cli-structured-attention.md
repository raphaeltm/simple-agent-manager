# CLI structured session attention decoding

## Problem

Valid API attention objects caused CLI session listing and viewing to fail with INVALID_JSON. The API emits markerId, kind, numeric createdAt, nullable numeric expiresAt, nullable string reason and string options; Session.Attention incorrectly expected a string.

## Research

- API contract: apps/api/src/services/session-summary-index.ts AttentionSummarySchema.
- Durable Object enrichment: apps/api/src/durable-objects/project-data/session-reads.ts enrichWithAttention.
- Shared consumers: ListSessions, GetSessionDetail, ProjectDetail.RecentSessions, chat/project/status commands.
- Existing fixtures omitted structured attention; regression coverage must include object, null and omitted cases.
- Pagination is explicitly outside scope; chat still fetches one page and exposes hasMore.

## Implementation checklist

- [x] Replace string with typed nullable AttentionSummary pointer.
- [x] Retain explicit null expiry/reason, options arrays and existing absent-attention JSON behavior.
- [x] Add synthetic client list/detail scenarios and command list/detail/project/status scenarios in text and JSON modes.
- [x] Assert HTTP method/path, session timestamps, message roles/content/timestamps and hasMore.
- [x] Reproduce object decoding error before fix, pass tests afterward.
- [x] Go race/coverage, vet, cross-builds and repository fast checks.
- [x] Independent local specialist reviews and findings addressed (three reviewers PASS, no findings).
- [x] Coordinated staging validation on reviewed code candidate (run 37910686532 PASS).
- [ ] Green CI, CodeRabbit requested/waited, merge.

## Acceptance criteria

1. Populated attention, nullable members, null and omitted attention decode in list and detail.
2. Text and JSON modes work for all shared Session consumers.
3. Message roles, millisecond/ISO timestamps, multiline/Unicode content and hasMore survive JSON output.
4. No credentials or private transcripts in fixtures, logs or PR; synthetic content only.
5. Appropriate Go tests, race/coverage/vet/build and repository checks pass.

## Verification

Original fixture matrix failed before the fix with object-to-string INVALID_JSON. New matrix passes. Go 1.26.6: CLI coverage 83.1%, overall 82.9%; client list/detail/project methods 100%. go vet and linux/darwin amd64/arm64 cross-builds passed. pnpm check:fast, stale-binary and source-contract guards passed; initial CI tests/build/typecheck/lint/CLI/Sonar passed. Preflight classification corrected and failed-job rerun requested.

## Delivery

PR #2290. User initially requested draft/no merge; 2026-10-09 follow-up explicitly authorized /do checks and merge. No production configuration changes or manual production deployment.

## Staging evidence

Deploy Staging 37910686532 passed on 44a5a82d2. Authenticated Playwright browser and downloaded public Linux amd64 CLI; embedded revision matched exactly. Smoke account had three populated attention objects. All eight chat list/detail/project/status text and JSON commands passed. Nine messages matched API content, roles and numeric/ISO timestamps; hasMore=false matched the live API. Populated attention decoded and round-tripped. No VMs or test resources provisioned. Private response values stayed in memory; logs contain only counts/revision/booleans.

Implementation acceptance is complete. The final CI/CodeRabbit/merge/automatic-deployment outcomes remain tracked in PR #2290 and local .do-state.md; do not infer merge from this implementation validation record.

## CodeRabbit review follow-up

CodeRabbit/Sonar identified excessive cognitive complexity in the two regression test orchestrators (39 and 99). Split scenario orchestration, HTTP setup, client checks and text/JSON assertions into focused helpers. All 40 scenarios remain; client-detail checks now compare the complete message array. Independent Go/test-completion reviewers passed again; full race suite remains 83.1% CLI coverage and vet passes. Production types/commands are unchanged after live staging verification. Final CI/Sonar/incremental-review outcomes are recorded in PR #2290.
