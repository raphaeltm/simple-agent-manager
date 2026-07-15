# Gate frontend prototype/test routes from production

## Problem

The web app currently registers prototype/test-only UI surfaces in the same router as production user-facing routes. In particular, `/sam` is a public unauthenticated prototype and `/__test/trial-chat-gate` is a Playwright harness route. `/ui-standards` is a protected design-system/governance surface that should remain available for local development but should not appear as a production app path.

This task creates a tightly scoped frontend PR to ensure prototype/test/demo surfaces do not leak into production routing or navigation.

## Scope

- `apps/web` routing, navigation, prototype/test/demo pages only.
- No backend, deployment, or product behavior changes.
- No production route breakage.
- Do not merge the PR.

## Research findings

- Primary router: `apps/web/src/App.tsx`.
- Public prototype/test routes currently registered:
  - `/sam` → `SamPrototype`, public unauthenticated prototype.
  - `/__test/trial-chat-gate` → `TrialChatGateHarness`, Playwright harness with mock data.
- Protected dev/design route:
  - `/ui-standards` → `UiStandards`, imported into production route tree.
- Prototype implementation files:
  - `apps/web/src/pages/SamPrototype.tsx`
  - `apps/web/src/pages/sam-prototype/*`
  - `apps/web/src/pages/TrialChatGateHarness.tsx`
  - `apps/web/src/pages/UiStandards.tsx`
- Existing audit tests reference harness/prototype routes:
  - `apps/web/tests/playwright/trial-chat-gate-audit.spec.ts`
  - `apps/web/tests/playwright/sam-prototype-audit.spec.ts`
- Relevant rules:
  - `.claude/rules/15-nav-parity.md`
  - `.claude/rules/17-ui-visual-testing.md`
  - `.claude/rules/37-prototype-development.md`

## Checklist

- [x] Add an explicit non-production route gate for dev/prototype/test-only routes.
- [x] Keep intended local/development access for prototype/test harness routes.
- [x] Ensure production users navigating directly to prototype/test/dev-only routes are redirected to the normal fallback.
- [x] Ensure production navigation does not expose prototype/test/dev-only surfaces.
- [x] Add unit coverage proving route registration behavior in production and development.
- [x] Run relevant frontend tests and quality checks.
- [x] Use UI and test review skills before finalizing.
- [ ] Open a PR on `sam/execute-task-using-skill-w566x5` and do not merge.

## Specialist review notes

- UI/UX review: PASS. This change affects route registration and navigation exposure only; no production visual layout changed. Existing Playwright visual audit for the trial chat harness passed on mobile and desktop, preserving intended local/dev access.
- Test engineering review: PASS. Coverage includes the explicit dev-only route inventory, dev/test accessibility for intentionally supported routes, production-disabled route gate behavior, and production nav-model absence. Full web unit coverage and root quality checks passed.
- Task completion validation: PASS. Research findings, checklist items, acceptance criteria, implementation diff, and validation evidence are aligned. Backend/resource/vertical-slice checks are not applicable because scope is frontend route/nav gating only.

## Validation evidence

- `pnpm --filter @simple-agent-manager/web test -- tests/unit/app-routes.test.tsx tests/unit/AppShell.test.tsx`
- `pnpm --filter @simple-agent-manager/web typecheck`
- `pnpm --filter @simple-agent-manager/web lint`
- `VITE_API_URL=https://api.example.test pnpm --filter @simple-agent-manager/web build`
- `pnpm --filter @simple-agent-manager/web test`
- `PLAYWRIGHT_BASE_URL=http://127.0.0.1:4173 npx playwright test tests/playwright/trial-chat-gate-audit.spec.ts --project="iPhone SE (375x667)" --project="Desktop (1280x800)"`
- `pnpm typecheck && pnpm lint && pnpm test && VITE_API_URL=https://api.example.test pnpm build`

## Acceptance criteria

- In production builds, `/sam`, `/__test/trial-chat-gate`, and `/ui-standards` are not reachable as app routes.
- In local/development builds, intentionally supported dev routes remain reachable for audits and design work.
- Production app navigation does not include prototype/test/demo routes.
- Existing production app routes continue to work.
- Tests prove both production-hidden and development-available behavior.
- Relevant local checks pass or any environmental blocker is documented with exact evidence.
