# Implement localhost-preserving CLI forwarding

## Problem

The current `sam workspace <id> forward` path binds a local listener but forwards through the public workspace port route. That rewrites browser-local authority to the public `ws-*--port` hostname, uses public port-access cookies/tokens, and risks consuming or stripping target application auth and cookies. Raphaël requires localhost semantics and auth/cookie isolation for CLI forwarding. The initial slice only needs HTTP forwarding; raw TCP and WebSocket/HMR can be explicitly unsupported.

## Human Constraints

- Stop at an open PR. Do not merge, close, or mark ready for merge unless Raphaël explicitly asks later.
- Do not deploy to staging and do not run staging deployment or staging smoke validation for this task.
- Push the SAM output branch early and after coherent implementation slices.
- Preserve these constraints in the PR body.

## Research Findings

- The crashed parent SAM session recovered durable idea `01KV99H6RX7B7JKQ63JYP54QA7` and its implementation plan before crashing.
- CLI forwarding currently lives in `packages/cli/internal/cli/workspace.go`, with API calls in `packages/cli/internal/cli/client.go` and tests in `packages/cli/internal/cli/workspace_test.go`.
- Public API port access currently lives in `apps/api/src/routes/workspaces/crud.ts`, public wildcard proxy logic in `apps/api/src/index.ts`, and public port JWT helpers in `apps/api/src/services/jwt.ts`.
- VM Agent public port proxy lives in `packages/vm-agent/internal/server/ports_proxy.go`; public workspace auth helpers in `workspace_routing.go` include cookie-writing paths that local forwarding must not reuse.
- This is a cross-boundary feature, so tests need realistic vertical slices across CLI -> API -> VM Agent boundaries where practical.

## Implementation Checklist

- [x] Add dedicated local-forward JWT audiences and helpers with claims for user/workspace/node/port/mode/local authority.
- [x] Add `POST /api/workspaces/:id/forwards` to authorize workspace ownership, validate port/local host, and mint a short-lived CLI forwarding token.
- [x] Add an API-domain local-forward proxy route that validates `X-SAM-Forward-Token`, rechecks workspace routing, strips spoofable forwarding/internal headers, preserves app auth/cookies, and sends `X-SAM-VM-Forward-Token` to the VM Agent.
- [x] Add a VM Agent local-forward handler and token validation path that does not set SAM session cookies, proxies only to the workspace container endpoint, preserves app auth/cookies, and sets localhost authority headers from validated claims.
- [x] Rewrite CLI local forwarding to create forward sessions, support `--local-port` and `--local-host`, validate inbound Host, preserve target app headers, strip spoofable headers, and use `X-SAM-Forward-Token` instead of app-visible `Authorization` or cookies.
- [x] Return a clear unsupported response for WebSocket upgrade requests if WebSocket proxying is not implemented in this slice.
- [x] Add focused CLI Go tests, API Vitest coverage, and VM Agent Go tests for token scope, localhost Host semantics, app `Authorization`/`Cookie`/multiple `Set-Cookie` preservation, and header stripping.
- [x] Run relevant tests for touched packages.

## Acceptance Criteria

- `sam workspace <id> forward --port 5173` prints a `http://localhost:<port>` URL.
- The target app receives `Host: localhost:<localPort>` and trusted `X-Forwarded-*` values consistent with local HTTP.
- App `Authorization`, `Cookie`, and multiple `Set-Cookie` headers are preserved.
- SAM forwarding tokens are not visible to the browser or upstream app.
- Wrong user/workspace/port/stopped workspace requests fail.
- Spoofed `X-SAM-*`, `Forwarded`, and `X-Forwarded-*` headers do not reach the app.
- VM Agent local-forward mode does not add SAM session cookies.
- WebSocket/HMR upgrade requests fail clearly when unsupported.
- Existing public `expose_port` / `ws-*--port` behavior remains separate.

## References

- Parent task: `01KV9AJD39GEP5G8JD3PWVG904`
- Durable idea: `01KV99H6RX7B7JKQ63JYP54QA7`
- Parent session: `99276e5f-b8d5-4480-b28b-42abafddba18`
- `.claude/rules/35-vertical-slice-testing.md`
- `.claude/rules/36-cli-quality.md`
