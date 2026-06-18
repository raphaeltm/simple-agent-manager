# Extract API Composition Root Modules

## Problem

`apps/api/src/index.ts` currently owns Cloudflare runtime exports, Hono app creation, global error handling, subdomain proxying, app-wide middleware, well-known endpoints, route registration order, MCP CORS behavior, 404 handling, and scheduled cron dispatch. Route order is behavior in Hono, especially for BetterAuth catch-all routes and project callback JWT routes, so the composition root should make those constraints explicit and testable.

## Human Constraint

- Do not deploy to staging.
- Do not merge the PR.
- Stop after local implementation, verification, and a draft/open PR clearly marked DO NOT MERGE / DO NOT DEPLOY TO STAGING.

## Research Findings

- Source idea: `01KVCX0V7QSPH7F9JEFK41FBKW`.
- SAM MCP task output branch: `sam/task-api-composition-root-01kvcz`.
- The referenced audit library files at `/engineering/code-elegance-audits/2026-06-18/` were not present in this workspace; the idea content includes the relevant audit diagnosis and target shape.
- `.claude/rules/34-vm-agent-callback-auth.md` records repeated production failures caused by putting callback JWT routes behind `/api/projects` session-auth middleware.
- `tasks/archive/2026-03-12-fix-workspace-callback-auth-middleware-leak.md` and `tasks/archive/2026-03-25-deployment-identity-token-middleware-leak.md` document the same Hono wildcard middleware leak class.
- Existing tests include route-order/source-shape tests and behavior tests around deployment identity token routing, workspace proxy port access, MCP routes, and scheduled jobs.

## Implementation Checklist

- [ ] Inventory the current `index.ts` responsibilities and route groups.
- [ ] Extract Hono app creation into `src/app/create-api-app.ts`.
- [ ] Extract global error handling, middleware, well-known routes, MCP CORS/routes, 404, workspace proxy, Pages proxy, and scheduled handling into explicit modules.
- [ ] Move route registration into named registration groups that encode order-sensitive behavior.
- [ ] Keep Durable Object runtime exports in `index.ts`.
- [ ] Preserve route paths, auth behavior, CORS behavior, response shapes, workspace proxy behavior, and scheduled behavior.
- [ ] Add or strengthen behavior tests for auth route precedence, project callback precedence, MCP CORS, workspace proxy pass-through/intercept behavior, well-known endpoints, 404, and scheduled delegation.
- [ ] Run API test, Worker test if relevant, typecheck, and lint.
- [ ] Open a draft/open PR marked DO NOT MERGE / DO NOT DEPLOY TO STAGING.

## Acceptance Criteria

- `apps/api/src/index.ts` is a thin Cloudflare Worker entrypoint plus Durable Object exports.
- App construction has a named module owner.
- Workspace proxy, Pages proxy, well-known endpoints, route registration, MCP CORS, errors/middleware, 404, and scheduled handling have explicit module owners.
- Route ordering constraints are encoded in named functions or registries, not only comments.
- Tests cover fragile route-order/auth/CORS/proxy/scheduled behavior.
- No staging deployment is performed.
- PR is clearly marked do-not-merge and do-not-deploy.
