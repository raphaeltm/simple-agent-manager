# L2: move the ws-* proxy out of apps/api/src/index.ts

Self-host landing plan slice L2 (idea `01M72M9AEB933ZY8269D376DKC`, "LANDING PLAN (part 5 of 7)").
Parent task `01M7AF82KG9C78WAABTG3V1MN1`; coordination channel `feature.selfhost-spike`.

**Human hold set by Raphaël:** he approves every merge to main for the self-host landing plan.
The pull request stays a DRAFT and is not merged or marked ready by the agent. This task file is
committed on the feature branch only (no direct-to-main task commit, for the same reason).

## Problem

`apps/api/src/index.ts` on main is 1,040 lines, over the 800-line hard limit (rule 18), and is on
the file-size exemption list. About 475 of those lines are one anonymous middleware: the
workspace-subdomain (`ws-{id}.*`, `ws-{id}--{port}.*`) proxy. The integration branch
`sam/selfhost-pass-2` already split it into `routes/workspace-subdomain-proxy.ts` and
`routes/workspace-port-access.ts`, but its copies also carry later behaviour changes that belong to
other slices. L2 lands only the file layout, with main's current behaviour.

## Research findings

- Block on main: `index.ts` lines 258-732, registered as the third `app.use('*')` after the
  interactive-preview host check and the Pages proxy, before request logging, analytics and
  `apiCors`.
- Integration branch layout: `workspaceSubdomainProxy(c, next)` (exported middleware) and
  `resolveWorkspacePortAccess(c, url, workspaceId, targetPort)` returning
  `{ userId, portAccessRedirect, publicPortAccess } | Response` (the 401 HTML page).
- The integration branch's `workspace-port-access.ts` body is byte-identical to main's inline block.
- Its `workspace-subdomain-proxy.ts` differs from main in out-of-scope behaviour only (input for L6
  and the reverse-tunnel / gateway slices): unconditional `redirect: 'manual'` on both proxied
  fetches (C4); `readNodeAgentRouteRow` / `nodeAgentRouteFromRow` / `NodeAgentRouteError` with a
  new 503 `NODE_UNREACHABLE` and a `node_route_unavailable` ports payload; reverse-tunnel loopback
  origin for `vmUrl`; Caddy forward_auth gateway (`isGatewayAuthorizationRequest`,
  `gatewayUnsupportedRuntimeResponse`, `gatewayDecisionResponse`); `x-sam-gateway-secret`
  stripping on both paths; self-host doc comment.
- Tests reading `src/index.ts` source for the moved code: `tests/unit/ws-proxy.test.ts`,
  `tests/unit/cf-container-runtime-contract.test.ts` (first case),
  `tests/integration/multi-workspace-nodes.test.ts`. They need file-path edits only.
- Tests reaching the proxy through the Worker entry (`worker.default.fetch`) stay untouched:
  `workspace-proxy-ownership`, `workspace-proxy-port-access`,
  `workspace-proxy-cf-container-reserved-port`, `routes/workspace-local-forward`, and Workers tests
  `workspace-preview-websocket`, `signup-approval-gate`, `d1-request-session`,
  `instant-sleeping-deletion-guard`.
- `scripts/quality/check-file-sizes.ts` exempts `apps/api/src/index.ts`; its own comment says to
  remove an entry once the file is split. No outbound-fetch inventory exists on main.
- Open PRs touching `index.ts` (#2605, #2308) change only import lines and route registrations,
  not the proxy block.

## Checklist

- [x] New `routes/workspace-port-access.ts` from main's lines 290-379 (dedented, wrapped)
- [x] New `routes/workspace-subdomain-proxy.ts` from main's lines 258-732 with the port block
      delegated
- [x] `index.ts`: `app.use('*', workspaceSubdomainProxy)` at the same position; unused imports removed
- [x] Source-contract tests repointed to the new file (path edits only)
- [x] Remove `apps/api/src/index.ts` from the file-size exemption list
- [x] Mechanical pure-move proof (`.tmp/l2/verify_pure_move.py`, output in PR)
- [x] Local gates: build, typecheck, check:fast, api unit (15,018 pass / 4 skip / 0 fail) + entry-level Workers tests (88), file sizes, ast-checks (0 errors, none in touched files), source-contract check
- [ ] Reviews: cloudflare-specialist PASS, architecture-reviewer PASS, task-completion-validator
- [ ] Staging: workspace UI (terminal + agent chat), port URL, public port, expired/missing cookie
      401 page compared with production; cleanup
- [ ] Draft PR with hold line, `needs-human-review`; CodeRabbit via workflow dispatch; report

## Acceptance criteria

- Every moved line is identical after ignoring indentation and import/export lines (script table).
- Middleware order in `index.ts` is unchanged.
- Existing tests pass with at most file-path edits; entry-level tests untouched.
- `index.ts` under 800 lines.
- Staging behaviour for workspace, port, public port and 401 page matches main/production.
