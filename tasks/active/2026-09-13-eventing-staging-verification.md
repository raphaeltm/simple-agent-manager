# Eventing staging verification — deployment blocked

Candidate: `sam/eventing-feature` at `4e69007c8f66d052c3ae8fad16bb5a80a3374f0c`.
Task: `01M2DSRGPH7R6DNM5XCRKHPQCR`; parent: `01M2CJMWKFGPV064H208AQFXGS`.
Scope: /do Phase 6 only. No fixes, redeploy, merge, PR #2031/#2073 changes, or SAM subtasks.

## Deployment result

**FAILED — not ready for merge consideration.**

[Workflow run 34768968036](https://github.com/raphaeltm/simple-agent-manager/actions/runs/34768968036), 2026-09-13 16:34:03–16:44:17 UTC.

The `Deploy API Worker` step failed at 16:44:13 UTC:

```text
Too many text bindings, found a total of 395, they exceed the limit of 350. Please use fewer bindings and try again. [code: 10055]
ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command failed with exit code 1: wrangler deploy --env staging
```

The user's explicit stop-on-deploy-failure instruction was followed. No attempt was made to fix or redeploy.

## Verification matrix

| Check | Result | Evidence |
| --- | --- | --- |
| Active staging deployment check | PASS | Latest prior run 34751262632 completed successfully; no active/queued staging deployment before dispatch. Remote branch SHA matched candidate. |
| Deploy feature branch | FAIL | Cloudflare error 10055 above; workflow smoke tests skipped. |
| D1 migrations 0157–0163 | PASS | CF API query of staging database `1cfaf5d4-8226-47d8-bf26-6ba727ce5718`, `d1_migrations`: all seven candidate migrations applied at 2026-09-13 16:39:38 UTC, ledger IDs 185–191. |
| DO migrations 047–056 | NOT DEPLOYED | CF script download after failure contains neither `056-project-event-orphan-retention-cursor` nor the wake flag. Worker class migration tag remains `v20`; this is a different sequence from application SQLite migrations 047–056. No candidate per-object migration execution is claimed. |
| Authenticated web app | NOT RUN | Stopped after deployment failure. Browser and Chromium were prepared but not exercised. |
| Events UI panels | NOT RUN | Candidate API did not deploy; no browser pass claimed. |
| GitHub webhook ingress | UNVERIFIED | Staging `github_webhook_deliveries` has zero rows before and after the attempt. No evidence confirms the prior signing-secret mismatch is fixed. No GitHub App delivery-log credentials were available. |
| Health and eventing API routes | NOT RUN | Stopped after deployment failure. |
| MCP tool listing | UNVERIFIED | No live authenticated tools/list sweep. Downloaded current Worker lacks `create_project_schedule`; existing subscription tools belong to the prior deployment and cannot validate this candidate. |
| Recent runtime errors | LIMITED / NO ROWS | Read-only observability D1 query found no `platform_errors` rows from 16:33 UTC through the 16:44:37 UTC diagnostic check. This is not candidate runtime proof because API publication failed. |
| Wake flag OFF | CONFIG ONLY | Candidate wrangler.toml line 271 and attempted deploy log both show `PROJECT_EVENT_WAKE_ENABLED="false"`. Current Worker settings have no binding with that name, and current bundle lacks the flag. Never enabled or changed during verification; candidate runtime resolution could not be tested. |

D1 filenames verified:

- `0157_project_event_source_outbox.sql`
- `0158_credential_limit_windows.sql`
- `0159_credential_limit_event_admissions.sql`
- `0160_task_submission_checkpoints.sql`
- `0161_project_event_source_outbox_durability.sql`
- `0162_reserved_task_session_revocations.sql`
- `0163_project_event_source_outbox_exhaustion_index.sql`

The previously applied, unrelated `0157_workspace_eviction_fencing.sql` remains in the ledger; migration names, not numeric prefixes alone, were checked.

## Partial deployment state

GitHub step results confirm these succeeded before the API failure: Pulumi infrastructure, D1 migrations/safety gates, versioned VM container artifact preparation, VM agent binary upload, tail Worker deployment, **web UI deployment**, and Worker secret configuration. The API Worker upload failed; later CLI upload and smoke tests were skipped.

Staging therefore has the candidate web UI and additive database migrations with the older API code. Treat it as a mixed, unverified deployment until the parent coordinates recovery. No rollback or second deployment was attempted.

CF Worker diagnostics: script `sam-api-staging`, class migration tag `v20`, reported script modified time `2026-09-13T10:26:18.661553Z`. A secret-triggered deployment at `2026-09-13T16:44:04.777756Z` has version `f901148c-42a9-4061-ae58-1845541358de`; this is **not** evidence that the candidate code deployed. Live settings enumerate 311 plain-text and 26 secret-text bindings. The rejected upload's authoritative total is 395 from Cloudflare's error.

No staging VM/workspace was provisioned by this verification. Baseline node query returned no active nodes. No resources require test cleanup.

## Targeted fixes for the parent

1. **Deployment blocker: excessive text bindings.** `apps/api/wrangler.toml:220` begins the dense eventing limit defaults; schedule/channel defaults are at lines 235/251, wake defaults at 271, credential-limit defaults at 281, and additional outbox defaults at 294. `scripts/deploy/sync-wrangler-config.ts:504` copies every top-level variable into the generated environment. Reduce the generated text-binding total by at least 45 (and retain operational headroom). Prefer omitting redundant default-valued bindings while preserving the existing shared constants and optional override behavior, or use an explicitly designed grouped configuration binding. Keep `PROJECT_EVENT_WAKE_ENABLED=false`. Existing fallback examples: `apps/api/src/durable-objects/project-data/project-events-limits.ts:16` and `project-event-channels-config.ts:27`. Verify each omitted value really matches its runtime fallback and retain a documented deploy override path; do not simply discard configuration support.
2. **Deployment guard:** add a check around generated config in `scripts/deploy/sync-wrangler-config.ts:943` and the reusable workflow before database/frontend mutations. Count the complete effective text-binding set, including secrets, and fail early with actionable evidence. Validate default staging/production generation and representative override cases. The current pipeline discovers this limit only at `.github/workflows/deploy-reusable.yml:1417`, after web publication at line 1335. Consider publishing API before web to reduce incompatible partial rollouts, separately from the immediate binding fix.
3. After the fix and a parent-authorized staging rerun, perform the full requested dormant-feature sweep. Obtain a real staging GitHub webhook delivery with successful signature verification and an authenticated staging MCP tools/list response; both remain verification gaps, not proven code defects.

No implementation files were changed. This report is the only committed artifact, on the task output branch. Latest observed Codex weekly usage was 73% (below the 80% stop threshold).
