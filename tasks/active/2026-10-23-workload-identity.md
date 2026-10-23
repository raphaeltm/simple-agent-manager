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
- [ ] Staging end-to-end token injection/signature verification and UI verification
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

## Durable release continuation (2026-10-23 13:35 UTC)

- Staging run [39960270167](https://github.com/raphaeltm/simple-agent-manager/actions/runs/39960270167) is still in progress at Deploy API Worker. Health and new discovery endpoint return 200. Do not dispatch a duplicate.
- Runtime SHA: `6fd025cceb78aae339b35e4d9a9d4c1f12797c0e`. Subsequent commits contain evidence/task notes only. No PR exists yet.
- Completion subscription: `0101c8ee-4c9d-4d19-92c7-a2ff706a10a7`; expires 2026-10-23 21:34:43 UTC; commit-scoped GitHub completion events, same-session delivery.
- Accepted one-shot fallback: `5de1c406-003a-4256-9019-c9848c02986c`, due 2026-10-23 13:40 UTC, expiry 14:10 UTC. Target chat `f7c065ab-39ae-40eb-ae70-178bb7c539a7`. Inspect/cancel obsolete own waits after reconciliation; do not blindly renew.
- No staging test task/workspace has been created. Prepared prompt is committed at `tasks/evidence/2026-10-23-workload-identity/staging-probe.md`; local scripts and PR draft are in `.codex/tmp/oidc-*`. Managed secret variables are placeholders in ordinary shells; use `exec_with_secrets` for `SAM_PLAYWRIGHT_PRIMARY_USER` and `CF_TOKEN`.
- Remaining: live token/metadata verification, cleanup, PR with linked screenshots, exact-head CI, CodeRabbit request/wait, merge and minimal production smoke. Human authorization for the full release is confirmed in the saved transcript.
