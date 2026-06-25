# Async build_and_publish jobs with polling

## Problem

`build_and_publish` currently blocks one MCP/API/VM HTTP request while the VM agent builds Docker Compose images, exports archives, uploads artifacts to R2, and records a release. The Dexxy incident on 2026-06-25 showed two failures about 125 seconds after `host build starting` on node `01KVY98XSGTJ0Q728TF5P4Z8XS`: first `docker save ... signal: killed`, then R2 upload `context canceled`. The likely cause is the Cloudflare-proxied request lifetime canceling the VM handler context, not the compose file location.

## Source Of Truth

SAM idea `01KVYWWTNB2808342VZYWR0NHB`, "Async build_and_publish jobs with polling and deployment-node apply events".

## Research Findings

- MCP tool definitions live in `apps/api/src/routes/mcp/tool-definitions-session-idea-tools.ts`.
- MCP dispatch is centralized in `apps/api/src/routes/mcp/index.ts`.
- `apps/api/src/routes/mcp/compose-publish-tools.ts` currently proxies `build-and-publish` and waits up to `BUILD_PUBLISH_TOOL_TIMEOUT_MS`.
- VM URLs and node-management auth are in `apps/api/src/routes/mcp/workspace-tools.ts`.
- Workspace callback auth for publish callbacks is in `apps/api/src/routes/projects/_callback-auth.ts`.
- Release recording is in `apps/api/src/routes/projects/compose-publish-release-callback.ts`.
- D1 deployment schema is in `apps/api/src/db/schema.ts`; next migration after `0076_deployment_custom_domains.sql` is `0077`.
- VM MCP build endpoint is in `packages/vm-agent/internal/server/mcp_build.go` and currently derives work context from `r.Context()`.
- Publish build/export/upload code is in `packages/vm-agent/internal/publish`.
- Deployment apply engine is in `packages/vm-agent/internal/deploy/engine.go`; it relies mostly on local logs and heartbeat summaries today.
- Callback routes called by VM agents must be mounted outside authenticated project routes per `.claude/rules/34-vm-agent-callback-auth.md`.
- Additive D1 migrations must follow `.claude/rules/31-migration-safety.md`.
- Cross-boundary changes need vertical slice tests per `.claude/rules/35-vertical-slice-testing.md`.

## Checklist

- [ ] Add D1 schema and migration for `deployment_publish_jobs`, `deployment_publish_job_events`, and `deployment_release_events`.
- [ ] Add API service support for publish job creation, state transitions, events, polling read model, and redaction.
- [ ] Change MCP `build_and_publish` to create a durable job, call a short VM start endpoint, and return `publishJobId` immediately.
- [ ] Add MCP `get_publish_status` tool and dispatcher.
- [ ] Add authenticated VM callback route for publish job progress and terminal persistence.
- [ ] Add authenticated node callback route/service for deployment release apply events.
- [ ] Change the VM agent to accept publish jobs and run build/publish in a job-owned background context independent of the start HTTP request context.
- [ ] Thread publish progress events through build/export/upload/release submission without leaking signed URLs, callback tokens, registry credentials, or secret values.
- [ ] Emit deployment-node apply events during release apply success/failure paths.
- [ ] Update deployment guide/tool descriptions and durable agent rules for async long-running MCP work.
- [ ] Add API tests for authorization, state transitions, callback persistence, polling output, and redaction.
- [ ] Add Go tests proving start-request cancellation after acceptance does not cancel background build/publish work.
- [ ] Add Go/API tests for deployment apply event emission/persistence.
- [ ] Run normal TypeScript and Go validation workflows.

## Acceptance Criteria

- `build_and_publish` returns a durable `publishJobId` within a short bounded time after VM acceptance.
- `get_publish_status` returns status, current step, recent events, terminal release/error fields, and polling guidance.
- Canceling or timing out the start HTTP request after acceptance does not cancel Docker build/export/upload/release submission.
- Publish job status and terminal state are durable in D1.
- The Dexxy failure class surfaces as a failed publish job event rather than an opaque MCP timeout.
- Deployment-node release apply emits persisted release-scoped events.
- Future agents are guided away from minutes-long blocking MCP/API/VM request chains.
