# Project Compute Credential Attribution

## Problem

Wave 5 for shared-project credential attribution must make project-attached compute credentials take effect during node provisioning and must pin credential attribution at the root of a task tree. Today `createProviderForUser()` delegates to the composable credential compute resolver without a `projectId`, so project compute attachments cannot win. Subtask dispatch paths also re-resolve credentials for child tasks instead of inheriting the root task's credential attribution.

## Research Findings

- SAM task: `01KWQH66K87YQ59GC0Z80ADBTY`; output branch: `sam/wave-5-project-level-01kwqh`.
- Product source: idea `01KVX4YP9C5255TEB28PGM1159`; shared resource attribution is creator-owned unless a project credential attachment exists, and task-tree descendants must inherit the root pin.
- Wave 4 health work added `apps/api/src/services/credential-attribution-health.ts` and trigger attribution metadata but intentionally did not change provisioning.
- `apps/api/src/services/provider-credentials.ts#createProviderForUser()` calls `resolveComputeConfig(db, userId, encryptionKey, targetProvider)` without `projectId`; `resolveComputeConfig()` already accepts `projectId`.
- `resolveCredentialSource()` still only checks legacy user/platform compute rows; quota prechecks in task submit, MCP dispatch, node routes, and TaskRunner provisioning therefore miss project attachments.
- `apps/api/src/services/nodes.ts#provisionNode()` records `nodes.credential_source` but not project vs personal attribution owner metadata. Teardown paths use node owner + cloud provider only; they need enough non-secret metadata to resolve through the same attribution scope used at creation.
- Trigger-created tasks preserve trigger creator attribution (`trigger.userId`) even after edits, but `submitTriggeredTask()` has a legacy direct credential precheck that rejects project/platform fallback.
- `apps/api/src/routes/mcp/dispatch-tool.ts`, SAM session dispatch, and retry-subtask paths create child tasks from the active actor/context and precheck credentials again; child task rows do not explicitly inherit a root attribution pin.
- Agent credentials are fetched by `apps/api/src/routes/workspaces/runtime.ts` using `workspace.userId` and `workspace.projectId`; if child workspace rows inherit the pinned user/project scope, agent key resolution follows the same pin.
- Existing schema has `tasks.agent_credential_source` and `nodes.credential_source` but comments/tests often assume only `user | platform`; shared `CredentialSource` already includes `project`.
- Rules read: 14, 28, 30, 32, 35, 41, 44, 45, 47. This task touches credential fallback and cross-boundary provisioning, so fallback branch tests and vertical-slice tests are mandatory.

## Implementation Checklist

- [ ] Add non-secret credential attribution pin metadata to tasks and nodes, with append-only migration and schema updates.
- [ ] Extend compute credential resolution to accept project scope and return project/personal/platform source metadata without exposing secrets.
- [ ] Update `createProviderForUser()` and `resolveCredentialSource()` to use project attachments, including Rule 28 inactive-project-attachment halt semantics.
- [ ] Pass project/attribution scope through task submit, TaskRunner provisioning, manual node creation, deployment provisioning, volumes, and teardown/lifecycle paths where project context exists.
- [ ] Ensure teardown resolves using the attribution metadata recorded at creation; do not implement Wave 6 offboarding behavior.
- [ ] Pin root task credential attribution once for user-created and trigger-created roots, then inherit that pin through MCP dispatch, SAM session dispatch, retry-subtask, and mission/task tree paths.
- [ ] Remove/replace trigger submission's legacy personal-cloud-credential precheck so project/platform fallback works.
- [ ] Update workspace/agent credential callbacks if needed so agent/LLM keys resolve against the inherited pin.
- [ ] Keep Wave 4 credential-attribution health accurate for project-vs-personal compute coverage.
- [ ] Add service/API tests for fallback branches: active project attachment wins, inactive attachment rejects without falling through, no attachment falls back to personal, no rows fail cleanly.
- [ ] Add vertical-slice tests proving project-attached compute credential is used for node provisioning and child dispatch inherits the root pin.
- [ ] Add canonical trigger regression: A creates trigger, B edits it, trigger fires, child dispatch inherits A or project credential attribution across the tree.
- [ ] Run focused tests during implementation and full `/do` validation.
- [ ] Run specialist reviews: task-completion-validator, security-auditor, cloudflare-specialist, constitution-validator, test-engineer.
- [ ] Deploy to staging and exercise real node provisioning with a project-attached compute credential; stop for human input if required staging config is missing.

## Acceptance Criteria

- Project-level compute credential attachments win for node provisioning when active.
- Inactive project compute attachments halt resolution and do not silently fall through to personal/platform credentials.
- Without a project attachment, compute resolution falls back to the pinned creator's personal credential, then platform where applicable.
- A root task's credential attribution pin is inherited by every descendant task/sub-agent and is not re-resolved against the dispatching actor.
- Trigger edits do not change attribution: creator A's trigger edited by member B still fires and dispatches descendants under A's pin unless an active project attachment exists.
- Node teardown/lifecycle cleanup uses the recorded non-secret attribution scope from creation.
- No secret values appear in new API responses, task metadata, logs, or errors.
- Bad credential rows degrade resolution/snapshot behavior per rule 41.
- Focused service/API tests plus at least one vertical-slice test cover project-attached compute provisioning and subtask inheritance.
- Staging verification provisions a real node using a project-attached compute credential before merge, or the PR is labeled `needs-human-review` and blocked with a human-input request.

## References

- `apps/api/src/services/provider-credentials.ts`
- `apps/api/src/services/composable-credentials`
- `apps/api/src/services/credential-attribution-health.ts`
- `apps/api/src/routes/projects`
- `apps/api/src/routes/triggers`
- `apps/api/src/durable-objects/task-runner`
- `apps/api/src/middleware/project-auth.ts`
- `tasks/archive/2026-07-04-credential-attribution-health.md`
- Rules: `.claude/rules/28-credential-resolution-fallback-tests.md`, `.claude/rules/35-vertical-slice-testing.md`, `.claude/rules/44-dual-write-migration-writer-enumeration.md`
