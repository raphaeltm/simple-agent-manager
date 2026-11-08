# Remove the legacy hosted SaaS anonymous-trial system

SAM task: `01M6Y0EGPR8PZMP9346SHEST08` · branch `sam/remove-legacy-hosted-saas-hest08` ·
coordination channel `feature.byoc-security-2026-11-08` (sibling credential task `01M6Y0DAXRD0S56125X2TQA7RF`).

## Problem

The anonymous "try SAM on any public repo" trial was built when SAM was considering a hosted
SaaS. Raphaël (2026-11-08): "I think we can completely destroy the trial system. It's from when I
was considering building a SaaS. I'm not any more. All focus on BYOC." The 2026-11-08 security
audit (Library `01M6XBX8SZDQGD5ZK87NDE3Y5P`) flagged that anonymous trials share one sentinel
owner and may reuse sentinel-owned nodes, so the per-user isolation boundary does not separate
trial visitors. Removing the product removes that exception.

## Research findings

### Live data (read-only D1 inventory, 2026-11-08)

| | staging | production |
|---|---|---|
| `trials` rows | 29, all `expired`, newest 2026-04-21 | 3, all `expired`, newest 2026-04-30 |
| claimed trials | 0 | 0 |
| `trial_waitlist` rows | 2 | 0 |
| sentinel-owned projects | 19 | 3 |
| sentinel-owned workspaces / nodes | all `deleted` | all `deleted` |
| projects on `system_anonymous_trials_installation` | 45 | 13 (10 are real users' artifacts/GitLab projects) |
| saved `trials.enabled` setting | none | none |

Conclusion: no active trial resources and no claimed trial data exist, so removing the expiry
sweep orphans nothing. The historical rows stay in place (no D1 DROP; migration-safety forbids it).

### Things that look like trial code but are NOT the anonymous trial (preserve)

- `system_anonymous_trials` user row: also the fallback `created_by` for platform-config rows
  (`platform-config-store.ts:creatorId`) and excluded from first-user superadmin / operator checks.
- `system_anonymous_trials_installation` row: the placeholder `installation_id` for artifacts and
  GitLab projects (`routes/projects/project-create.ts`, migration 0047). Deleting it would cascade
  into real projects. Both rows stay; the shared constant is renamed to a system-row name with the
  same value, and the existing env overrides keep working.
- `GET /api/trial-status` + `services/platform-trial.ts`: authenticated installation platform
  credential + AI proxy availability (project → user → platform fallback UX). Kept; user-facing
  copy saying "platform trial" becomes "platform compute".
- Partial unique index `idx_projects_user_installation_repository ... WHERE user_id != sentinel`
  is real DB state; schema.ts keeps mirroring it.

### Anonymous-trial surface to remove

- API routes: `routes/trial/*` (`/api/trial/create|claim|status|waitlist|:id/events`),
  `routes/admin-trials.ts` (`/api/admin/trials/*`), OAuth callback claim-cookie hook in
  `routes/auth.ts` (`services/trial/oauth-hook.ts`).
- Services: `services/trial/*` (bridge, cookies, discovery prompt, github knowledge, helpers,
  kill switch, oauth hook, runner, store); bridge call sites in ProjectData DO, idea-core,
  knowledge MCP tool, workspace runtime route.
- DOs: `TrialCounter`, `TrialEventBus`, `TrialOrchestrator` (+ bindings, env, vitest configs).
- Scheduled: `trial-expire`, `trial-rollover`, `trial-waitlist-cleanup` and crons `0 4 * * *`,
  `0 5 1 * *` (only used by trial jobs).
- Admin settings: `trials.enabled` definition, `Trials` category, `legacyKv: 'trials'`.
- AI proxy trial attribution (`trialId` metadata; admin AI-usage/costs trial split).
- `assertTrialProvisioningAuthority`, placement source `trial-orchestrator`, MCP/session
  `contextType`/`promptKind` `'trial'`, rate-limit `TRIAL_CREATE`/`TRIAL_SSE`.
- Shared: `packages/shared/src/trial.ts`, `constants/trial-orchestrator.ts`.
- Web: `/try*` pages, trial components/hooks/libs, chat-gate harness, AdminTrials page, nav and
  command-palette entries, admin API client functions.
- Deploy/config: `TRIAL_*` vars and `.env.example`, `REQUIRED_SECRETS` entry,
  `configure-secrets.sh` trial secret + `ANTHROPIC_API_KEY_TRIAL`, staging "enable trials" KV step,
  worker-var defaults, runtime-tunables baseline, churning-table entry `trial_waitlist`,
  node-pool boundary inventory entries, DO-migration-safety scan of `trial-counter.ts`.
- Docs: architecture overview/security, admin-settings, configuration, self-hosting,
  notifications, self-host page, agent rules/skills that describe trial behaviour as current.

### Cloudflare/Pulumi upgrade safety decisions

- **DO classes**: Cloudflare refuses a deploy that stops exporting a class created by a migration
  unless a `deleted_classes` migration exists, and `deleted_classes` irreversibly deletes storage.
  Keep migrations v7–v9 untouched and export the three classes as inert tombstones (fetch → 410,
  alarm → no-op). Bindings are removed. Works for upgrades (classes still exported) and clean
  installs (migrations create classes that are simply never bound).
- **Pulumi `trial-claim-token-secret`** is `protect: true`; deleting it from the program fails
  `pulumi up` on every existing stack, including forks that skip versions. Keep the resource
  declared (retired, unused) and stop exporting/copying it. The Worker secret already set on
  existing deployments is left in place (inert).
- No D1 migration: tables/rows stay as history; no code reads or writes them.

## Implementation checklist

- [ ] Shared: delete `trial.ts`, `constants/trial-orchestrator.ts`; add system-row id constants
- [ ] API: delete trial routes/services/DO implementations/scheduled jobs/admin route and their tests
- [ ] API: tombstone DO classes; remove bindings from wrangler.toml, env.ts, vitest configs
- [ ] API: `/api/trial/*` → 410 Gone with self-host pointer; test proves no D1/DO access
- [ ] API: remove OAuth claim hook, bridge call sites, ai-proxy trialId, provisioning-authority trial
      assertion, placement source, MCP/session `'trial'` context, rate-limit buckets
- [ ] API: remove `trials.enabled` admin setting + category + legacy KV plumbing
- [ ] API: scheduled handler + wrangler crons without trial jobs
- [ ] API: rename sentinel constant usages (auth, operator notifications, platform-config store,
      project-create) to system-row constants; keep env overrides
- [ ] Web: remove trial pages/components/hooks/libs, AdminTrials, nav + palette entries, admin API
      fns, AI usage/costs trial split; `/try*` → retired-trial redirect to self-host page
- [ ] Web: reword "platform trial" copy to platform compute
- [ ] Deploy/infra: secrets lists, configure-secrets, staging KV step, worker-var defaults,
      runtime tunables baseline, churning tables, node-pool inventory, DO migration scan,
      Pulumi output removal (resource retained)
- [ ] Docs + agent rules/skills sync
- [ ] Playwright screenshots of retired `/try` page (375 + 1280) and admin nav
- [ ] Full quality suite

## Acceptance criteria

- [ ] `POST /api/trial/create`, `/claim`, `/waitlist`, `GET /api/trial/status`, `/api/trial/:id/events`
      return 410 and touch no D1/DO/KV (test)
- [ ] `/api/admin/trials/*` no longer exists (404)
- [ ] OAuth callback no longer issues trial claim cookies (test)
- [ ] `/api/trial-status` platform availability still works (existing tests)
- [ ] Artifacts/GitLab project creation still uses the system installation row (existing tests)
- [ ] First-user superadmin / operator lists still exclude the system user (existing tests)
- [ ] Worker still exports TrialCounter/TrialEventBus/TrialOrchestrator; wrangler migrations unchanged
- [ ] Web `/try`, `/try/<id>` show the retired notice and redirect to the self-host page
- [ ] Staging: deploy succeeds (upgrade path); retired endpoints 410; normal VM task + Instant
      chat still provision; no new sentinel-owned rows created
- [ ] Production: deploy succeeds; retired endpoint 410; basic smoke

## References

- Audit: Library `01M6XBX8SZDQGD5ZK87NDE3Y5P`
- Rules: 31 migration safety, 07 env/urls (DO migrations), 25 review gate, 30 never ship broken
