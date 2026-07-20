# Long-Running MCP Tools Must Be Async

Long-running MCP tools must not block on VM work that can exceed normal HTTP, proxy, or client timeouts. Use a durable job id plus polling/status tools.

## Rule

- Start operations return quickly with a durable job id after the VM accepts work.
- Polling tools return status, current step, recent events, and terminal release/error details.
- VM job contexts must be independent of the HTTP request context after acceptance.
- Progress and terminal state must be persisted before agents are told to treat work as complete.
- Events must be bounded and redacted. Do not persist or expose signed R2 URLs, callback tokens, registry credentials, Authorization headers, JWTs, env dumps, or secret values.
- Long-running VM work must not be bounded by undersized fixed wall-clock deadlines when it can make legitimate slow progress. Use transport phase timeouts plus progress/idle watchdogs for streamed uploads/downloads, Docker build/save/load, deployment apply, and similar operations.
- Any timeout or idle window for long-running VM work must be env-configurable with a `Default*` constant, and tests must include both slow-but-progressing and stalled/no-progress cases.
- Before merging VM work that crosses process, HTTP, or Cloudflare proxy boundaries, reviewers must trace whether the execution context derives from the original request/client deadline after acceptance. If it does, the PR must move the work to a job-owned context or explicitly prove the operation is bounded below the request deadline.

## Scope: Any Synchronous Control-Plane → VM/Container Request Doing Data-Scaled Work

This rule is not limited to MCP tools. Any control-plane request that waits synchronously on VM/container work whose cost scales with data the platform does not control (repository size, artifact size, image size) is in this class. The request timeout must be a dedicated, env-configurable budget sized for the work — never the interactive node-agent default — and the work itself must be made size-proportional where possible (shallow/partial clones, streamed transfers, filters).

## Incident Lesson

On 2026-07-18/19, ALL production instant (cf-container) sessions failed for ~28 hours: the standalone vm-agent clones the repository synchronously inside the control plane's create-workspace request (`handleStandaloneWorkspaceCreate`), which ran under the interactive 30s `DEFAULT_NODE_AGENT_REQUEST_TIMEOUT_MS`. When accidental auto-commits of `.codex/` runtime state tripled the repo pack to 371 MiB, full-clone time crossed 30s on the container's fractional vCPU and every instant launch died with `Request timed out after 30000ms` (or worse: stuck `queued` when the client disconnected). Two margins eroded silently — clone cost grew with unmonitored repo history, and the fixed interactive deadline had no headroom. Fix: partial clone (`--filter=blob:none`, `STANDALONE_CLONE_FILTER`) making clone cost proportional to the working tree, plus a dedicated `CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS` (default 120s) budget. See `tasks/archive/2026-07-19-fix-instant-container-clone-timeout.md`.

On 2026-06-25, Dexxy compose publishing failed twice on node `01KVY98XSGTJ0Q728TF5P4Z8XS` around 125 seconds after `host build starting`: first during `docker save` with `signal: killed`, then during R2 upload with `context canceled`. The likely cause was the synchronous MCP API to Cloudflare-proxied VM HTTP request and the VM handler deriving its long-running build context from `r.Context()`. Moving the compose file later may have made one run faster, but it was not the architectural fix.

On 2026-06-25, Dexxy deployment apply also failed while loading an R2-backed docker-save artifact because the deploy engine's default `http.Client{Timeout: 30s}` bounded the entire streamed response body read. Large artifact downloads must use transport phase timeouts and an idle body-read watchdog, not a total client timeout.
