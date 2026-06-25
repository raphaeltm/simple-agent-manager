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

## Incident Lesson

On 2026-06-25, Dexxy compose publishing failed twice on node `01KVY98XSGTJ0Q728TF5P4Z8XS` around 125 seconds after `host build starting`: first during `docker save` with `signal: killed`, then during R2 upload with `context canceled`. The likely cause was the synchronous MCP API to Cloudflare-proxied VM HTTP request and the VM handler deriving its long-running build context from `r.Context()`. Moving the compose file later may have made one run faster, but it was not the architectural fix.

On 2026-06-25, Dexxy deployment apply also failed while loading an R2-backed docker-save artifact because the deploy engine's default `http.Client{Timeout: 30s}` bounded the entire streamed response body read. Large artifact downloads must use transport phase timeouts and an idle body-read watchdog, not a total client timeout.
