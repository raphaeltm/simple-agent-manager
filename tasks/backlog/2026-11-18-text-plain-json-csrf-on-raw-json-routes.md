# Same-site text/plain CSRF on routes that parse JSON with raw `c.req.json()`

## Problem

Workspace port pages (`ws-<id>--<port>.<BASE_DOMAIN>`) are same-site with the API, so the browser
sends them the session cookie. Credentialed CORS (`middleware/api-cors.ts`) only protects requests
that need a preflight. A `POST` with `Content-Type: text/plain` is CORS-simple: it reaches the
handler with the cookie and no preflight.

Hono's `c.req.json()` parses the body without checking `Content-Type`. Any cookie-authenticated
POST route that reads its body with raw `c.req.json()` (instead of `jsonValidator`, which checks
the JSON content type) therefore accepts a forged JSON body from a same-site page.

Example found while finishing PR #2865 (multipart variant):
`POST /api/projects/:projectId/environments/:envId/runtime/env-vars`
(`apps/api/src/routes/deployment-environment-config.ts`) calls
`parseConfigRequest(await c.req.json())` behind `requireAuth()` and `secret:write`.

Other candidates to check: `c.req.json()` and `c.req.text()` in `apps/api/src/routes/`
(`grep -rn "c\.req\.\(json\|text\)()" apps/api/src/routes`), excluding bearer/callback-only routes.

## Context

Discovered 2026-11-18 by SAM task `01M7PX499FF397BR3VWYTD3HQT` while confirming Codex Security
finding `acf_063f530a5742d0498761f77e05d88516` (PR #2865). Not verified on staging yet.

## Acceptance Criteria

- [ ] Every cookie-authenticated POST route that parses a body refuses a CORS-simple body from a
      non-app origin (either require a JSON content type, or apply `requireTrustedWriteOrigin`)
- [ ] A worker test through `SELF.fetch` with a session cookie, `Origin: https://ws-...` and
      `Content-Type: text/plain` gets 403/415 and changes nothing; an app-origin control succeeds
- [ ] Removing the guard turns the attack test red
