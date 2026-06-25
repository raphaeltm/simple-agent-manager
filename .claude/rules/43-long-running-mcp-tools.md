# Long-Running MCP Tools Must Be Async

Long-running MCP tools must not block on VM work that can exceed normal HTTP, proxy, or client timeouts. Use a durable job id plus polling/status tools.

## Rule

- Start operations return quickly with a durable job id after the VM accepts work.
- Polling tools return status, current step, recent events, and terminal release/error details.
- VM job contexts must be independent of the HTTP request context after acceptance.
- Progress and terminal state must be persisted before agents are told to treat work as complete.
- Events must be bounded and redacted. Do not persist or expose signed R2 URLs, callback tokens, registry credentials, Authorization headers, JWTs, env dumps, or secret values.

## Incident Lesson

On 2026-06-25, Dexxy compose publishing failed twice on node `01KVY98XSGTJ0Q728TF5P4Z8XS` around 125 seconds after `host build starting`: first during `docker save` with `signal: killed`, then during R2 upload with `context canceled`. The likely cause was the synchronous MCP API to Cloudflare-proxied VM HTTP request and the VM handler deriving its long-running build context from `r.Context()`. Moving the compose file later may have made one run faster, but it was not the architectural fix.
