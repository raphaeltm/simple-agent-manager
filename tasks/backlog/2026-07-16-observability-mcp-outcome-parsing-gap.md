# Observability MCP tool cannot return in-request `console.error` log lines

## Problem

The Cloudflare observability MCP tool cannot surface in-request `console.error`
(and other in-request `console.*`) log lines because its schema rejects events
that lack an `outcome` field. In-request log events emitted mid-handler do not
carry `outcome` (that field is only present on the terminal worker-invocation
event), so the tool drops them. This blocks reading production stack traces for
handled 500s and other in-request diagnostics via the MCP path — forcing
`wrangler tail` or local repro instead.

## Context / where discovered

Discovered while debugging the intermittent sessions-list `INTERNAL_ERROR` on
large projects (`tasks/active/2026-07-16-fix-sessions-list-internal-error-large-projects.md`).
The real prod stack trace could not be read through the observability MCP tool
because of this gap; root cause had to be established from code inspection +
local regression tests instead.

## Acceptance criteria

- [ ] The observability MCP integration can return in-request `console.*` log
      lines that lack an `outcome` field (relax/branch the schema, or add a thin
      log-fetch path that does not require `outcome`).
- [ ] Verify against a worker that emits a mid-request `console.error` on
      staging: the line is retrievable via the MCP tool.
- [ ] Document the retrieval path so future agents can read prod stack traces
      without `wrangler tail`.

## Notes

- Do NOT fix in the sessions-list PR — this is a tooling/integration change,
  filed separately per that task's instructions.
- Workaround today: `wrangler tail --env <env>` or local Miniflare repro.
