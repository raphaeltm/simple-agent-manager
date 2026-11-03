# Instant (cf-container) Workspace Deletion Stuck on `request_failed`

## Problem

On staging, seven Instant (cf-container) workspaces have been stuck in `stopping` for up to
18 hours. The NodeLifecycle deletion queue keeps retrying them and never converges:

| Workspace                  | Node status | Last diagnostic                                                         |
| -------------------------- | ----------- | ----------------------------------------------------------------------- |
| 01M6CYR2S52Z5JF5VSK6KDJY6H | sleeping    | `Workspace deletion unconfirmed: VM attempt 58 (Error: request_failed)` |
| 01M6CZ20D18FWCN4G68EJKYDFV | sleeping    | attempt 58, `request_failed`                                            |
| 01M6D5KY707D6JGHN9YMTGGZKQ | recovery    | attempt 29, `request_failed`                                            |
| 01M6D5R4V381N8TXYP7HBK33PK | sleeping    | attempt 53, `request_failed`                                            |
| 01M6HCCD63N8586E3P4679EBRX | sleeping    | attempt 6, `request_failed`                                             |
| 01M6GXNAE8AWVYJ7X2YRB81QX8 | sleeping    | attempt 11, `request_failed`                                            |
| 01M6GY9E3K25YRRG0X0KC5KFB3 | sleeping    | attempt 11, `request_failed`                                            |

(Staging D1 query 2026-11-03 ~20:11Z. Production had no stuck cf-container rows at that
time.) A separate `stopping` row, `01M2CX7BFQ64E1KY2E91148Y5C`, has had no node since
2026-09-13 (`Runtime deletion unconfirmed after attempt 1 (node assignment unavailable)`).

## Context

Found while fixing slow VM workspace deletion
(`tasks/active/2026-11-03-fast-workspace-physical-deletion.md`). For a cf-container node
whose status is not `running`, `requestWorkspaceDeletion` in
`apps/api/src/services/workspace-deletion.ts` destroys through the container DO
(`stopNodeResources` with `workspaceDeletion`). Something on that path, or the
pre-mutation boundary checks, throws a plain `Error` that `deletionFailureDiagnostic`
categorizes as `request_failed` on every attempt.

## Acceptance Criteria

- [ ] Identify the exact throw site from staging logs (`wrangler tail` or `/admin/logs`
      filtered by `workspace_deletion.unconfirmed` and the workspace IDs above)
- [ ] Sleeping or recovering Instant workspaces reach `deleted` (or a terminal, surfaced
      dead-letter state) instead of retrying indefinitely
- [ ] The diagnostic names the real failure, not a generic `request_failed`
- [ ] Regression test through `attemptWorkspaceDeletion` with a sleeping cf-container node
- [ ] Decide what happens to the node-less `stopping` row from 2026-09-13
