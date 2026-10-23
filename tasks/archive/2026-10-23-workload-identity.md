# Provider-neutral execution workload identity

## Request

Implement and release short-lived OIDC tokens through exec_with_secrets. Include authoritative project, user, active profile, chat/runtime session, task and automation provenance with IDs and descriptive labels. Document trust setup and expose copyable identities in the UI. External trust setup remains user-owned.

## Research

- jwt.ts already signs GCP federation tokens and exposes discovery/JWKS; generic issuance must not change GCP contracts.
- Internal JWTs share signing keys: external audiences must exclude all internal audiences; tests must reject workload tokens at internal verifiers.
- Existing kid uses calendar month. Publish a key-thumbprint kid under a separate /oidc issuer/JWKS; leave legacy issuer/endpoints untouched for existing runtimes.
- secret-exec-tools privately delivers managedEnv to VM with exact-value redaction and stable request fingerprints. Reuse this path; no raw token in MCP result or persistence.
- Runtime assets resolve the actual agent_sessions profile, not task hints.
- Task submission checkpoints carry authoritative source kind/id/execution for triggers, schedules, watches and workflows; task rows carry trigger provenance and parent IDs. Never infer origin from prompts.
- Existing chat Details already has copyable session/task/runtime IDs. Add a focused workload identity disclosure there rather than several new settings screens.
- Relevant incidents: callback auth routing rule34; runtime validation rule51; phase5 review-before-merge rule14. New metadata route uses session auth, not callback auth.

## Implementation checklist

- [x] Generic bounded workload JWT signer, stable kid, internal audience separation
- [x] Authoritative session/profile/task/provenance resolver, safe labels, no sensitive content
- [x] Optional oidc request, reserved injected env, retry-safe fingerprint, no token persistence
- [x] Read-only metadata API and copyable UI identities on mobile/desktop
- [x] User guide, claims contract, provider examples, operational limitations, config/API references
- [x] Unit/integration tests for issuance, auth, provenance, redaction, retries, UI behavior
- [x] Local lint/typecheck/test/build and visual audit
- [x] Independent local security/domain/completion reviews
- [x] Staging end-to-end token injection/signature verification and UI verification
- [ ] PR green, CodeRabbit requested/waited/addressed, merge and production smoke

## Acceptance

No GCP setup required. Claims derive only from trusted stored context. IDs are intended for authorization; labels are mutable and descriptive. No generic JWT authenticates to SAM internal endpoints. Claims omit unavailable provenance rather than inventing it. Empty secretNames works. Raw token never returned to the model. UI allows copying identities without minting tokens. Existing secret execution and GCP federation remain compatible.

## UI variants

1. Add IDs across separate settings/profile/automation pages: useful but scatters trust setup.
2. Add a dedicated settings page: unnecessary navigation for a small feature.
3. Selected: workload identity disclosure in existing chat Details, showing exact available session claims plus issuer/subject and copy buttons. Keeps IDs together without crowding normal chat.

## Resumed validation

- Lint, typecheck, build, runtime-tunable and agent-context-budget checks passed.
- Full API: 938 files / 13,444 tests passed (1 file / 2 tests skipped).
- Other packages: 18 tasks passed; web passed 4,555 tests with one unrelated comment scrolling timing assertion; its complete 15-test file passed on isolated rerun.
- OIDC Playwright: four tests passed on mobile/desktop; all six screenshots reviewed and preserved under `tasks/evidence/2026-10-23-workload-identity/`.
- Final completion/doc review passed; stale admin-setting count corrected.
- Staging deployment: run 39960270167, runtime commit 6fd025cceb78aae339b35e4d9a9d4c1f12797c0e. Live verification pending.

## Staging result and release continuation (2026-10-23 13:52 UTC)

- Deployment 39960270167 succeeded, including smoke tests, on runtime SHA `6fd025cceb78aae339b35e4d9a9d4c1f12797c0e`. Later commits are documentation/evidence only.
- Real VM `exec_with_secrets` with empty secretNames and OIDC audience verified public JWKS signature, issuer, audience, actual runtime/profile/session/task claims and 300-second TTL. Captured stdout/stderr both contain `[REDACTED]`, exit 0; safe result is in the evidence directory.
- Live mobile Playwright verified metadata and profile-ID clipboard copying with no page errors. Desktop verified unavailable identity after runtime deletion. All six local stress screenshots had already passed review on both viewports. Initial desktop multi-page navigation stayed on the loading spinner; direct navigation subsequently loaded normally with no page errors. No product change was required.
- Test workspace `01M5MFX8ZEH0ZZ3VMQJDC9DPM0` and node `01M5MFQJ513V9G49JHK59YQKY0` deleted through normal APIs; Cloudflare D1 readback confirmed both absent. No staging compute remains from this test.
- Staging completion event processed/acked; subscription `0101c8ee-4c9d-4d19-92c7-a2ff706a10a7` and fallback `5de1c406-003a-4256-9019-c9848c02986c` cancelled. Repeated lookup after cancellation correctly lacked visibility.
- Implementation and staging complete. Release gates remain tracked in the PR: exact-head CI, CodeRabbit request/wait, merge and minimal production smoke. Human authorization for full release is confirmed in the saved transcript.

## Review cleanup

CodeRabbit found invalid audiences returned a generic execution failure. Added three regression cases (reserved audience, inner whitespace, leading whitespace), observed them fail, and mapped only audience validation to INVALID_PARAMS before secret resolution. Existing generic redaction-safe handling remains unchanged. Extracted the unchanged execution-identity predicate to reduce complexity, simplified null guards, and used readonly props/native output elements for status feedback. These address all eight reported Sonar findings; final CI analysis will confirm.

Focused API: 79 tests across four files passed. Four mobile/desktop OIDC Playwright tests passed; all six regenerated screenshots reviewed without overflow/clipping. UI variants for this semantic cleanup: retain ARIA spans, use native output with existing styling, or add a shared status wrapper. Selected native output as the smallest accessible solution. Rubric: hierarchy4, interaction4, mobile4, accessibility5, consistency4. No effect/click behavior changes. Independent cleanup reviewer PASS: authorization/claims preserved; no missing tests or blockers. Final-head CI/staging and incremental review remain pending.
