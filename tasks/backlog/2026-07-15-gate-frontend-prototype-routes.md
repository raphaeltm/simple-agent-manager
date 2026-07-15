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

- [ ] Add an explicit non-production route gate for dev/prototype/test-only routes.
- [ ] Keep intended local/development access for prototype/test harness routes.
- [ ] Ensure production users navigating directly to prototype/test/dev-only routes are redirected to the normal fallback.
- [ ] Ensure production navigation does not expose prototype/test/dev-only surfaces.
- [ ] Add unit coverage proving route registration behavior in production and development.
- [ ] Run relevant frontend tests and quality checks.
- [ ] Use UI and test review skills before finalizing.
- [ ] Open a PR on `sam/execute-task-using-skill-w566x5` and do not merge.

## Acceptance criteria

- In production builds, `/sam`, `/__test/trial-chat-gate`, and `/ui-standards` are not reachable as app routes.
- In local/development builds, intentionally supported dev routes remain reachable for audits and design work.
- Production app navigation does not include prototype/test/demo routes.
- Existing production app routes continue to work.
- Tests prove both production-hidden and development-available behavior.
- Relevant local checks pass or any environmental blocker is documented with exact evidence.
