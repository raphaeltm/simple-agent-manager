# Fix project-level compute credential overrides

- SAM Task: 01KWRXY1A4NRREKES5CD12JQF2
- Output branch: `sam/fix-project-level-compute-01kwrx`

## Problem Statement

Project Settings -> Connections currently shows cloud provider rows, but configured compute rows have no actions because `ConnectionsOverview` gates replace, disconnect, default, and project override controls behind `consumerKind === 'agent'`. At the same time, `/settings/cloud-provider` saves legacy `cloud-provider` rows only to `credentials`, while resolution and provisioning read from `cc_*`. Existing users with any CC data skip lazy backfill, so freshly saved Hetzner keys can be invisible and resolution falls through to platform.

This blocks Wave 5 credential attribution validation: a user saving a Hetzner key must see it as `your default`, and a project must be able to add, replace, and remove a compute project override.

## Research Findings

- `apps/web/src/components/ConnectionsOverview.tsx` renders compute rows with only `onConnect` and `deepLinkPath="/settings/cloud-provider"`. `ConnectionRow` only exposes `canProjectOverride`, `canMakeDefault`, `canReplace`, `canDisconnect`, and validation when `isAgent` is true.
- `apps/web/src/components/ConnectFlow.tsx` is agent-only. Parent pages (`SettingsConnections.tsx`, `ProjectConnectionsSection.tsx`) ignore compute consumers or only deep-link them.
- User-scoped cloud save/update/delete lives in `apps/api/src/routes/credentials.ts`:
  - `POST /api/credentials` creates or updates `credential_type='cloud-provider'` rows.
  - `DELETE /api/credentials/:provider` deletes legacy cloud-provider rows.
  - `POST /api/credentials/validate` is read-only validation and does not persist.
- Project-scoped legacy credentials already use `credentials.project_id`, and shared backfill (`packages/shared/src/composable-credentials/backfill.ts`) already maps project-scoped cloud-provider rows to compute project attachments. There is no project cloud-provider route today.
- Existing project agent credential routes in `apps/api/src/routes/projects/credentials.ts` provide the right capability and route shape pattern, but only for `credential_type='agent-api-key'`.
- `apps/api/src/services/composable-credentials/agent-sync.ts` has reusable patterns for deleting scoped attachments and inserting credential/configuration/attachment triples, but it is agent-specific.
- `apps/api/src/services/composable-credentials/lazy-backfill.ts` only runs when a user has zero `cc_credentials`, so it does not reconcile legacy-only cloud-provider rows for active users.
- `apps/api/src/routes/resolution-status.ts` calls lazy backfill before `buildSnapshot()`, so extending lazy reconciliation there covers already-desynced legacy cloud-provider keys before UI status is built.
- `apps/api/src/services/provider-credentials.ts` uses `resolveForConsumer()`/snapshot for compute resolution before falling back, so CC reconciliation also affects provisioning.
- Relevant retained incident: `tasks/archive/2026-06-30-fix-production-codex-oauth-refresh-429.md` documents this dual-write desync class and introduced Rule 44.

## Legacy `credentials` Writers Enumeration (Rule 44)

- `apps/api/src/routes/credentials.ts` `POST /api/credentials`: cloud-provider create/update. Must dual-write CC compute user attachment.
- `apps/api/src/routes/credentials.ts` `DELETE /api/credentials/:provider`: cloud-provider delete. Must remove CC compute user attachment.
- `apps/api/src/routes/gcp.ts` setup save/update: cloud-provider GCP writer used by `/settings/cloud-provider`. Must dual-write CC compute user attachment.
- `apps/api/src/routes/projects/credentials.ts` existing project agent PUT/DELETE: already dual-writes via `syncAgentCredentialToCC` / `disconnectAgentCredentialFromCC`.
- New project cloud-provider PUT/DELETE routes: must dual-write CC compute project attachment.
- `apps/api/src/routes/credentials.ts` agent credential PUT/toggle/delete/delete-all: already dual-write through agent-sync helpers.
- `apps/api/src/durable-objects/codex-refresh-lock.ts`: agent OAuth rotation writer; already syncs `cc_credentials` per the 2026-06-30 fix.
- `apps/api/src/routes/workspaces/runtime.ts`: agent credential runtime update writer; already syncs active CC credential secret.
- Migrations under `apps/api/src/db/migrations/`: historical migrations, not runtime writers.

## Implementation Checklist

- [x] Add compute-specific CC sync helpers that mirror legacy cloud-provider credentials into `cc_credentials`, `cc_configurations`, and `cc_attachments` for user and project scopes.
- [x] Extend lazy backfill/reconciliation so existing legacy-only cloud-provider rows are mirrored even when the user already has other CC data.
- [x] Update user-scoped cloud-provider save/update/delete routes to dual-write or disconnect compute CC rows.
- [x] Update GCP setup save/update path to dual-write compute CC rows.
- [x] Add project-scoped cloud-provider save/delete routes using project `secret:write` capability checks and preserving inactive-project-row halted behavior.
- [x] Add web API client functions and a compute-capable connection flow for cloud-provider rows.
- [x] Wire `SettingsConnections` and `ProjectConnectionsSection` so compute rows support Make default, Replace, Project override, and Disconnect/Remove override actions where valid.
- [x] Add API behavioral tests per cloud-provider writer proving both legacy and CC representations update/delete.
- [x] Add vertical-slice test proving a freshly saved user Hetzner key resolves as `user-attachment`, not `platform`, through `GET /api/credentials/resolution-status`.
- [x] Add Rule 28 fallback matrix coverage for compute consumers, including inactive project row halting fallback.
- [x] Add/update UI unit tests for compute row action rendering and parent callback wiring.
- [x] Run Playwright visual audit for Connections UI at 375px and 1280px with normal, long, many, empty, error/special-character scenarios.
- [ ] Run quality checks and staging verification of the actual flow: save cloud provider key -> see `your default`; add project override -> see `project override`.

## Acceptance Criteria

- [x] Saving a Hetzner key at `/settings/cloud-provider` shows Hetzner as `your default` in user Connections and in project Connections with no project override.
- [x] Project Settings -> Connections can add a project-level Hetzner override, replace it, and remove it.
- [x] Existing legacy-saved cloud-provider keys become visible to CC resolution/status even when the user already has other CC rows.
- [x] Compute fallback matrix is covered, including inactive project rows blocking fallback.
- [x] Playwright screenshots are captured and inspected for mobile 375px and desktop 1280px.
- [ ] Staging validates the live user flow end to end before merge.

## Verification Notes

- Unit and contract tests cover user cloud create/update/delete, GCP setup create/update, project cloud create/update/delete, resolution-status source selection, compute fallback behavior, and UI action wiring.
- Focused Playwright audit passed for cloud-provider default and project override flows on iPhone SE 375x667 and Desktop 1280x800 in both dark and light themes.
- Local `test:workers` is blocked by repeated `workerd` signal 11 crashes, including when selecting an existing lazy-backfill test. The D1 regression for legacy-only cloud-provider reconciliation remains in the worker suite, but local execution cannot complete in this environment.

## References

- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/28-credential-resolution-fallback-tests.md`
- `.claude/rules/44-dual-write-migration-enumerate-writers.md`
- `tasks/archive/2026-06-30-fix-production-codex-oauth-refresh-429.md`
