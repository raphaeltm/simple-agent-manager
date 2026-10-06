# CORS Origin Fallthrough Bug

## Problem

The CORS middleware in `apps/api/src/index.ts` unconditionally reflects the requesting `Origin` header as the allowed origin in its fallthrough case. The `origin` callback returns the incoming origin for all cases — `localhost`, `*.baseDomain`, **and unknown origins**. Combined with `credentials: true`, this allows any website to make credentialed cross-origin requests to session-authenticated API routes.

## Location

`apps/api/src/index.ts:368-380` (CORS middleware)

## Context

Discovered during security review of the MCP server feature (PR #agent-platform-awareness-mcp). This is a pre-existing issue, not introduced by the MCP feature.

## Acceptance Criteria

- [x] CORS `origin` callback returns `null` for unrecognized origins (only allow `localhost` and `*.baseDomain`)
- [x] Existing CORS tests updated to verify unknown origins are rejected
- [x] MCP endpoint (`/mcp`) has explicit CORS override: `credentials: false`, `origin: '*'` (token auth, no cookies)
