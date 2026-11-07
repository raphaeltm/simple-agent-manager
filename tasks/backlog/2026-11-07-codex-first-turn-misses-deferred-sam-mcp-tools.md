# Codex says `get_instructions` is unavailable on its first turn

## Problem

Codex sessions sometimes answer the SAM bootstrap line ("Before starting any work, you MUST call
the get_instructions tool from the sam-mcp MCP server") with "`sam-mcp.get_instructions` isn't
available in this session" and stop, even though the SAM MCP server is configured and reachable.
Codex defers MCP tools behind its built-in tool discovery, and on the first turn the model does not
search for them. Asked again to search, the same session finds `mcp__sam_mcp__get_instructions`.

## Context

- Seen on staging 2026-11-07 while verifying the Codex apps/plugins default
  (`tasks/archive/2026-11-07-codex-disable-apps-plugins-by-default.md`), project `hono`
  (`01KTKXZ4ZZAT6MJFXRW1ZTQ7RB`): VM session `1724ccd7-ce30-4d8b-81ca-4bc9621ffe44` and Instant
  session `2f627440-9911-46b3-9b9c-b7832959cac8`, both on a Codex subscription credential.
- Not caused by that change: production sessions without it show the same reply, for example
  session `c79237e1-dd56-49fb-b535-30f57f698833` (2026-11-01) and
  `f4b29b14-615d-4307-9dce-761082516265` (July 2026).
- With API-key auth and a mock model, Codex 0.160.0 sends `mcp__sam_mcp` tools directly in the
  first request, so the deferral seen in these sessions depends on the auth mode or model.
- Claude Code has a similar report: `tasks/backlog/2026-10-19-staging-claude-sam-mode-cannot-call-deferred-mcp-tools.md`.

## Acceptance Criteria

- [ ] Reproduce on staging with a Codex subscription session and record whether the first request
      exposes SAM MCP tools directly or only through discovery
- [ ] Codex follows the `get_instructions` bootstrap on the first turn in a new session (for example
      by naming the discovery step in the bootstrap text or exposing `get_instructions` eagerly)
- [ ] A staging Codex session calls `get_instructions` without a follow-up prompt
