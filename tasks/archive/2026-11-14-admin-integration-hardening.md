# Admin integration hardening: clear integrations, truthful source labels, owner security alerts

Task: 01M7E4J4NMDTQ1WMRXNGF0H5AA (coordinator 01M7DJT04N8DYW1T5VF30ETCQZ, channel `feature.setup-takeover-fix`).

## Problem

Follow-up to the 2026-11-12 setup-takeover incident (contained). Three gaps made it slow to notice and awkward to clean up:

1. Admin → Integrations can only overwrite values; there is no way to clear an integration, so cleanup meant deleting D1 rows by hand.
2. The source label did not tell the operator where a value came from or who set it.
3. Nobody was told when integrations changed, setup completed, or a new social account was linked to an admin.

## Research findings

- Writers of `integration.*` settings / integration credentials (rule 44 enumeration):
  - `PUT /api/admin/platform-config` → `savePlatformIntegrationConfig` (`platform-config-core.ts`)
  - `POST /api/setup/complete` → `completeSetupWithConfig` (`platform-config-core.ts`)
  - `PATCH /api/admin/settings` → `updateAdminSettings` (`admin-settings-mutations.ts`) for registry OAuth names
  - `admin-runtime-controls.ts`, `operational-kill-switch.ts`, `connector-settings.ts` call `updateAdminSettings` but only with non-integration names.
- Repro of the label (local, real SQLite, rows seeded exactly as `/setup/complete` writes them with `updated_by = system_anonymous_trials`): current code reports `source: runtime`, label **"set here"** for host, clientId and clientSecret. So on current code a D1 value is not labelled "environment". What *is* wrong:
  - `resolvePlatformConfig` maps every non-`database`/`default` admin-setting source (i.e. `kv`) to `'environment'` — untruthful, though unreachable for OAuth definitions today.
  - "set here" says nothing about who wrote it; an attacker's setup write looked identical to an admin's save. The per-field "last changed by" audit line exists only for Google infrastructure.
  - The integration badge collapses mixed sources (one field stored, one from env) to "set here".
- Staging state (read-only D1 + Worker settings, 2026-11-14): GitLab host/clientId/secret and Google-infra are D1-stored; GitHub OAuth and GitHub App come from Worker env secrets; `AGENT_EMAIL` send binding present; one superadmin.
- Existing clear-like paths: `googleInfrastructure.remove` (form + statements) and `feedback.remove`. `updateAdminSettings` resets registry names (value null → delete row/credential, audit `reset`). GitHub App / webhook fields are not in the registry.
- Email: `agentEmailSenderFor(env)` (`@simple-agent-manager/agent-email`) is the sender used by `deliverSignInCode`.
- BetterAuth `databaseHooks.account.create.after` is not used yet; `createAuth` already accepts `waitUntil`.

## Implementation checklist

- [x] API: `config.clear: IntegrationGroup[]` on `PUT /api/admin/platform-config`; deletes stored settings rows and `platform_credentials` rows for each group; audits `reset` per stored field through `commitAdminSettingsStatements`; invalidates the platform config cache; rejects clear + set of the same group
- [x] Replace `googleInfrastructure.remove` with the generic clear (no duplicate path)
- [x] Source labels: `legacy-kv` source, exhaustive mapping, truthful labels; mixed-source integration label; `clearable` flag
- [x] Field audit: "changed <time> by <actor>" for every stored field, `system_anonymous_trials` → "first-run setup (unauthenticated)"
- [x] UI: Clear button per integration section with danger ConfirmDialog; no reload; labels from server
- [x] `services/security-alerts.ts`: recipients (active superadmins), best-effort send in `waitUntil`, plain wording, admin links from `BASE_DOMAIN`
- [x] Alerts wired: admin platform-config PUT (set/clear), admin settings PATCH (integration names), setup complete (one call), account link hook (one hook block)
- [x] Tests: clear route (rows + audit gone/created, env fallback reappears), D1 value never labelled environment, alert module (recipients, failure isolation, wording), hook filter, route wiring
- [x] Docs: admin/self-hosting docs mention clearing + alerts
- [x] Playwright visual audit 375/1280
- [x] Staging: set + clear test integration (not GitLab), label check, alert delivery evidence

## Acceptance criteria

- Clearing any integration group from Admin → Integrations removes its D1 rows and secret rows, writes `reset` audit rows, and the page updates without reload.
- A D1-stored value is never labelled as an environment fallback (test).
- Superadmins receive an email for integration changes, setup completion, and new social account links to admin/superadmin users; send failures never fail the mutation.

## Notes

- Setup alert recipients fall back to `BOOTSTRAP_OWNER_EMAIL` when no superadmin exists (after the parallel fix, setup closes once a superadmin exists, so the alert would otherwise reach nobody).
- Actor labels (emails) are only returned to the superadmin admin route, never to the setup-token-gated `/api/setup/*` responses.
- Clears skip the OAuth id/secret pair validation on purpose: an admin must always be able to delete stored values.
- Discrimination checks run: label mapping revert -> 2 label tests red; clear statements removed -> 4 clear tests red; account hook removed -> 2 link-alert tests red.

## Staging evidence (run 43657273196, 2026-11-15)

- Labels: GitLab/Google-infra `stored in SAM` with the admin's name; GitHub OAuth/webhook `Worker environment fallback`.
- GitHub webhook secret set then cleared through the UI. Audit rows: set (revision 58), reset (revision 59). Credential row deleted. Env fallback restored. No reload, no console errors.
- Workers Observability: 2 × `security-alerts.security_alert.sent` (integration-changed, recipients 1, failed 0).
- Blocker found and fixed separately: the ubuntu-latest → 26.04 migration broke the VM-agent artifact upload and the Playwright installs (#2744). Follow-up: `tasks/backlog/2026-11-15-vm-agent-reproducible-build-across-runners.md` (in #2744).
