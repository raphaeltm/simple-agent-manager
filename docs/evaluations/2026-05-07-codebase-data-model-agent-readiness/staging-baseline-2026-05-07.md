# Staging Baseline - 2026-05-07

Status: In progress.

Orchestrator task: `01KR0DBHQWK0XJW610HR7CPGS9`

UTC start timestamp: `2026-05-07T05:14:00Z`

## Purpose

Capture the current Cloudflare staging state before implementation work from the 2026-05-07 evaluation backlog. This baseline is required before any high-risk work touching data model, migrations, configuration, Durable Objects, D1, KV, R2, Wrangler, or deployment pipeline behavior.

## Required Evidence

- [ ] Deployed Workers and routes.
- [ ] D1 databases and relevant table/schema state.
- [ ] Durable Object bindings, classes, and migrations.
- [ ] KV namespaces used by staging.
- [ ] R2 buckets used by staging.
- [ ] Worker logs/errors/tail output where available.
- [ ] Relevant GitHub Actions deploy history.
- [ ] Current staging app/API health.
- [ ] Current staging data shape for projects, users, workspaces, tasks, sessions, and messages.

## Command Log

Record every command with UTC timestamp, redacting tokens and sensitive user data.

| Timestamp UTC | Command | Purpose | Result |
| --- | --- | --- | --- |
| 2026-05-07T05:14:00Z | `printenv CF_TOKEN >/dev/null && printf 'CF_TOKEN=set\n' || printf 'CF_TOKEN=missing\n'` | Confirm Cloudflare staging token presence without printing it. | `CF_TOKEN=set` |
| 2026-05-07T05:14:00Z | `printenv SAM_PLAYWRIGHT_PRIMARY_USER >/dev/null && printf 'SAM_PLAYWRIGHT_PRIMARY_USER=set\n' || printf 'SAM_PLAYWRIGHT_PRIMARY_USER=missing\n'` | Confirm staging smoke-test auth token presence without printing it. | `SAM_PLAYWRIGHT_PRIMARY_USER=set` |
| 2026-05-07T05:14:00Z | `gh auth status` | Confirm GitHub Actions/deploy-history access. | Authenticated as `simple-agent-manager[bot]` using `GH_TOKEN`. |
| 2026-05-07T05:16:17Z | `curl -s -H "Authorization: Bearer $CF_TOKEN" "https://api.cloudflare.com/client/v4/accounts/c4e4aebd980b626f6af43ac6b1edcede/workers/scripts"` | List deployed staging Workers, routes, handlers, and DO classes. | Success. Workers: `sam-api-staging`, `sam-tail-worker-staging`. API worker routes include `api.sammy.party/*`, `*.sammy.party/*`, `app.sammy.party/*`, `www.sammy.party/*`, `sammy.party/*`. API named classes include `AdminLogs`, `CodexRefreshLock`, `NodeLifecycle`, `NotificationService`, `ProjectAgent`, `ProjectData`, `ProjectOrchestrator`, `SamSession`, `SandboxDO`, `TaskRunner`, `TrialCounter`, `TrialEventBus`, `TrialOrchestrator`. Migration tag: `v13`. |
| 2026-05-07T05:16:17Z | `curl -s -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" -d '{"sql":"SELECT (SELECT count(*) FROM users) AS users, ..."}' "https://api.cloudflare.com/client/v4/accounts/c4e4aebd980b626f6af43ac6b1edcede/d1/database/1cfaf5d4-8226-47d8-bf26-6ba727ce5718/query"` | Read staging D1 aggregate row counts. | Success. Counts: users 4, projects 23, tasks 8, nodes 32, workspaces 50, agent_sessions 29, sessions 3629. Rows written: 0. |
| 2026-05-07T05:16:17Z | `curl -s -i https://api.sammy.party/health` | Check staging API health. | HTTP 200, body `{"status":"healthy","timestamp":"2026-05-07T05:16:17.756Z"}`. |
| 2026-05-07T05:16:18Z | `gh run list --workflow=deploy-staging.yml --limit=5 --json databaseId,status,conclusion,createdAt,headBranch,displayTitle` | Check recent staging deploy history. | Last five staging deploys were successful. Most recent: run `25435527905`, branch `sam/compact-mode-lazy-load-tool-content`, created `2026-05-06T12:34:42Z`. |
| 2026-05-07T05:17:00Z | `curl -s -H "Authorization: Bearer $CF_TOKEN" "https://api.cloudflare.com/client/v4/accounts/c4e4aebd980b626f6af43ac6b1edcede/storage/kv/namespaces/cbeb633bc3794dd88a0b488d46a1922d/keys?limit=20"` | List staging KV key metadata. | Success. Namespace currently lists `platform:ai-proxy:default-model` and `trials:enabled`. |
| 2026-05-07T05:17:00Z | `curl -s -H "Authorization: Bearer $CF_TOKEN" "https://api.cloudflare.com/client/v4/accounts/c4e4aebd980b626f6af43ac6b1edcede/r2/buckets/sam-staging-assets/objects"` | List staging R2 object metadata. | Success. Bucket includes VM agent binaries `agents/vm-agent-linux-amd64` and `agents/vm-agent-linux-arm64`, harness binary `experiments/harness-linux-amd64`, and encrypted library objects. Result was truncated after 20 objects. |
| 2026-05-07T05:17:00Z | `curl -s -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" -d '{"sql":"SELECT * FROM d1_migrations ORDER BY id DESC LIMIT 10"}' ...` | Read staging D1 migration state. | Success. Latest migrations: id 57 `0048_missions.sql` applied `2026-04-26 09:42:07`; id 56 `0047_artifacts_repo_provider.sql` applied `2026-04-25 11:41:29`; ids 55-48 cover 0046 through 0040. |
| 2026-05-07T05:17:00Z | `curl -s -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" -d '{"sql":"SELECT name, type FROM sqlite_master WHERE type IN (...) ORDER BY type, name LIMIT 80"}' ...` | Read staging D1 table/index inventory sample. | Success. Confirmed indexes include `idx_projects_installation_id`, `idx_tasks_project_status_priority_updated`, `idx_workspaces_chat_session_id_unique`, `idx_workspaces_node_display_name_unique`, and many others. Full table/schema detail pending baseline subtask. |

## Preliminary Findings

- Staging API is healthy at `https://api.sammy.party/health` as of `2026-05-07T05:16:17Z`.
- Recent staging deployment pipeline history is green: the five most recent `deploy-staging.yml` runs returned `success`.
- Deployed staging Worker inventory matches the expected split: `sam-api-staging` plus `sam-tail-worker-staging`.
- The API Worker currently exposes DO classes for the main high-risk surfaces: `ProjectData`, `TaskRunner`, `NodeLifecycle`, `ProjectOrchestrator`, `SamSession`, `CodexRefreshLock`, and trial/admin/sandbox DOs.
- Staging D1 has non-empty existing data that must remain compatible across deployments: users 4, projects 23, tasks 8, nodes 32, workspaces 50, agent sessions 29, sessions 3629.
- Staging D1 latest migration is `0048_missions.sql` with `d1_migrations.id = 57`.
- Staging KV namespace `sam-staging-sessions` currently has two visible keys from the sampled listing: `platform:ai-proxy:default-model` and `trials:enabled`.
- Staging R2 bucket `sam-staging-assets` contains current VM agent binaries and encrypted library objects.
- Deeper baseline collection is delegated to SAM task `01KR0DRSGDM3T84Q04Q8TBGK2W`, including full schema detail, DO binding/migration reconciliation, logs/errors, authenticated app health, and session/message persistence shape.

## Compatibility Notes

Until this document is complete, high-risk implementation tasks remain blocked. Documentation/task-shaping work may proceed because it does not alter deployed behavior.

## Post-Deploy Verification Template

Every implementation task should append or link evidence covering:

- Current staging state relevant to the change.
- Expected staging state after deployment.
- Visible behavior change, if any.
- Compatibility risk for existing deployments.
- Rollback strategy.
- Exact automated tests.
- Exact manual staging checks.
- Log/error checks.
- Cleanup steps for any live test resources.
