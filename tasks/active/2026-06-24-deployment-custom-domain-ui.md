# Deployment Custom Domain UI

## Problem

Deployment custom-domain CRUD exists in the API, but the production environment detail page has no surface for attaching, verifying, inspecting, or deleting custom domains. The web app only receives `routeHostnames: string[]`, while the attach endpoint requires the selected public route's `service`, `port`, and hostname metadata.

## Research Findings

- `apps/api/src/routes/deployment-custom-domains.ts` already implements custom-domain create/list/verify/delete under `/api/projects/:projectId/environments/:envId/custom-domains`.
- `apps/api/src/services/deployment-custom-domains.ts` exposes `getEnvironmentPublicRouteTargets()` and `buildVerifiedCustomRouteTargets()`.
- `apps/api/src/services/deployment-routing.ts` derives deterministic route targets with `{ hostname, service, containerPort, hostPort }`.
- `apps/api/src/services/deployment-environment-summary.ts` currently exposes only `routeHostnames` in environment responses.
- `apps/web/src/lib/api/deployment.ts` has deployment environment wrappers but no custom-domain or public-route wrappers.
- `apps/web/src/pages/ProjectDeploymentEnvironmentDetail.tsx` has tabs for overview/logs/config/policy/node but no Domains tab.
- Prototype branch `prototype/deployment-custom-domains-ui` contains a reference-only route at `apps/web/src/pages/deployment-domains-prototype/` with route selector, cards, DNS record cells, and state handling. It also includes a fake Apply routes button that must not ship in production.
- Existing backend tests include `apps/api/tests/unit/routes/deployment-custom-domains.test.ts` and `apps/api/tests/unit/routes/deployment-custom-domains-vertical.test.ts`.
- Existing Playwright visual audits include `apps/web/tests/playwright/deployment-control-surface-audit.spec.ts`, which already mocks the environment detail page.

## Implementation Checklist

- [x] Add production public-route metadata support for a deployment environment, preferably `GET /api/projects/:projectId/environments/:envId/public-routes`.
- [x] Add backend tests for the public-route response and access/error behavior.
- [x] Add typed web API wrappers for public-route listing and custom-domain CRUD in `apps/web/src/lib/api/deployment.ts`.
- [x] Add a production Domains tab to `ProjectDeploymentEnvironmentDetail.tsx` using real API data.
- [x] Implement route selector, add-domain form, DNS record display, copy/verify/delete/open actions, failure states, route-missing state, and no-route/no-domain states.
- [x] Make activation copy accurate: verified domains become active on the next deployment apply unless route re-apply behavior is actually implemented.
- [x] Add focused frontend tests if practical.
- [x] Add or extend Playwright visual audit coverage for the Domains tab at mobile 375x667 and desktop 1280x800 with overflow assertions.
- [x] Run relevant API tests, web tests, typecheck/build/lint as feasible.
- [ ] Open PR from the SAM output branch, run required checks, deploy/verify staging, and merge only when gates pass.

## Acceptance Criteria

- Users can select a real existing public route and attach a custom subdomain using `{ service, port, hostname }`.
- Users see the exact CNAME record name/value for both pending and existing domains.
- Users can verify DNS and see verified, pending, failed, and route-missing states.
- Users can delete custom domains.
- The UI handles environments with no public routes and routes with no custom domains.
- No prototype route, mock data, or fake Apply routes action ships.
- Backend and frontend contracts are typed and covered by focused tests.
- Playwright screenshots confirm the Domains tab has no horizontal overflow at 375x667 and 1280x800.
