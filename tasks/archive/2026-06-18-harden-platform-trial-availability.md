# Harden Platform Trial Availability

## Problem

The platform trial/catalog availability slice currently advertises platform OpenCode as configured when the platform cloud credential row exists but cannot be decrypted in the availability path. That is an unsafe user-facing capability signal: if this code cannot validate the credential, the platform path should fail closed instead of presenting platform infrastructure and AI as ready.

The same slice lacks focused service tests and silently normalizes malformed `AI_PROXY_DAILY_INPUT_TOKEN_LIMIT` values to defaults. The authenticated current-user `/api/trial-status` endpoint and anonymous `/api/trial/status` monthly-cap endpoint also need clearer code/test naming so their semantics are not conflated.

## Research Findings

- `apps/api/src/services/platform-trial.ts` owns `getPlatformOpencodeAvailability()` and `getTrialStatus()`.
- `getPlatformOpencodeAvailability()` catches `DOMException` `OperationError` from `getPlatformCloudCredential()` and currently sets `hasInfraCredential = true`, which can make `available = true`.
- `apps/api/tests/unit/routes/agents-catalog.test.ts` locks in that unsafe behavior with a test named `matches trial semantics for platform credential decryption operation errors`.
- `getTrialStatus()` parses daily token budget env vars with `parseInt(...) || DEFAULT`, so invalid, zero, and negative values are silently accepted as defaults or limits.
- `apps/api/src/services/ai-token-budget.ts` has the same lenient parser in `resolveEffectiveLimits()`, so budget enforcement should share the stricter parser with trial status.
- `apps/api/src/routes/trial.ts` serves authenticated `/api/trial-status`, used by `apps/web/src/lib/api/misc.ts`, and returns per-user platform trial availability plus token budget/usage.
- `apps/api/src/routes/trial/status.ts` serves anonymous `/api/trial/status`, used as a public monthly trial availability snapshot for landing/waitlist flows.
- `apps/api/src/routes/agents-catalog.ts` directly uses platform OpenCode availability to compute OpenCode fallback configuration and has minor formatting issues in imports.
- Relevant rules: `.claude/rules/03-constitution.md`, `.claude/rules/11-fail-fast-patterns.md`, `.claude/rules/28-credential-resolution-fallback-tests.md`, `.claude/rules/41-credential-snapshot-resilience.md`.

## Implementation Checklist

- [x] Move this task to `tasks/active/` on the feature branch.
- [x] Change platform OpenCode availability to fail closed on platform credential decryption `OperationError`.
- [x] Add an explicit positive-integer parser for AI proxy daily token limits, defaulting only when unset and throwing on malformed, zero, or negative configured values.
- [x] Reuse the stricter daily token limit parser in `getTrialStatus()` and `resolveEffectiveLimits()`.
- [x] Add focused `platform-trial` service tests for infra credential present/absent, AI proxy enabled/disabled, decryption `OperationError`, non-DOM errors, daily budget defaults/parsing, invalid env values, and token usage propagation.
- [x] Add authenticated `/api/trial-status` route tests for current-user availability, fallback response on service/config errors, and route semantics.
- [x] Update `/api/agents` catalog tests so decryption failures do not mark OpenCode configured, while generic availability failures keep the catalog response available.
- [x] Clarify authenticated `/api/trial-status` vs anonymous `/api/trial/status` naming/comments/test descriptions.
- [x] Format/clean the `agents-catalog.ts` helper/import boundaries without broad refactors.
- [x] Run targeted tests and relevant lint/typecheck checks.
- [x] Run `constitution-validator` and `security-auditor` specialist checks before PR.
- [ ] Deploy and verify on staging unless blocked by project policy.
- [ ] Open a PR with the spot-check findings and exact checks run.

## Acceptance Criteria

- [x] Platform OpenCode/trial availability does not advertise readiness when the platform credential cannot be decrypted in this path.
- [x] Authenticated trial-status and agent catalog behavior have direct regression coverage.
- [x] Invalid configured AI proxy daily token limits are not silently accepted as defaults.
- [x] Endpoint naming/semantics are clearer in code and test descriptions.
- [x] Frontend call sites still hit authenticated `/api/trial-status`.
- [ ] PR summary includes the spot-check findings and exact checks run.

## References

- SAM task: `01KVC8XF1FVQ0DHV4F3FH77H92`
- `apps/api/src/services/platform-trial.ts`
- `apps/api/src/routes/trial.ts`
- `apps/api/src/routes/agents-catalog.ts`
- `apps/api/src/routes/trial/status.ts`
- `apps/api/src/services/ai-token-budget.ts`
- `apps/api/tests/unit/routes/agents-catalog.test.ts`
- `apps/api/tests/unit/routes/trial-status.test.ts`
- `apps/web/src/lib/api/misc.ts`
