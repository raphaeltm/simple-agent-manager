# Complete React Router 7.14.2 -> 8.5.1 (PR #2798)

SAM task 01M7MPMWG0B3D8PSN7QGSTTYEP. Dependabot PR #2798, head e4fbfc2be724d00b1868c09baead8779690fb516.

## Problem

Dependabot bumped the `react-router` catalog pin to the 8.x major. Decide whether the upgrade is a
narrow, supported change for SAM or needs a coordinated migration, and finish or close it.

## Research findings

- Upstream v8.0.0 major changes (package CHANGELOG.md in react-router@8.5.1): ESM-only packages,
  Node >= 22.22.0, React >= 19.2.7, `react-router-dom` removed, `future.v8_*` flags removed,
  `hasErrorBoundary` route prop removed, `meta` `data` param removed, middleware always on.
  8.4.0 changes exported `UNSAFE_` contexts. 8.5.0 deprecates `viewTransition` APIs.
- SAM consumers: `apps/web` and `packages/ui` (dev/peer). All 253 imports come from `react-router`
  (none from `react-router-dom` or `react-router/dom`). Declarative mode only: `BrowserRouter`,
  `MemoryRouter`, `Routes`, `Route`, `Link`, `NavLink`, `Navigate`, `Outlet`, hooks, `matchPath`.
  No `UNSAFE_*`, `future`, `hasErrorBoundary`, `viewTransition`, data-router or framework APIs.
- React is 19.3.1 (satisfies >= 19.2.7). CI uses Node `22` (latest 22.x); the root `engines`
  floor and the local-development guide still say 22.14, below the new 22.22 floor.
- Head e4fbfc2 full CI suite already green (web tests, build, typecheck, DO workers).

## Checklist

- [x] Raise root `engines.node` floor to `^22.22.0 || >=24.0.0`
- [x] Update `apps/www/.../guides/local-development.md` Node version line
- [x] Add a real-`BrowserRouter` regression test: deep link, relative `<Navigate replace>`, back/forward
- [x] lint, typecheck, web tests, build
- [x] Visual audit: CI Playwright Visual Tests passed; staging browser run at desktop/mobile (local Chromium blocked, see notes)
- [x] Reviews: ui-ux, security, constitution, task-completion (all PASS)
- [ ] Staging: navigation, auth, deep-link, back/forward on leased installation
- [ ] CI + CodeRabbit request/wait, merge, production deploy + smoke

## Acceptance criteria

- PR #2798 merged with react-router 8.5.1, no consumer regressions.
- Regression test proves deep links, replace-redirects and history traversal work under v8.
- Staging navigation/auth/deep-link/back-forward verified on a leased installation.

## Notes
- Branch updated from main by merge (no force push). Consumer commit pushed on the Dependabot branch.
- Local: lint 22/22, typecheck 36/36, web 5379/5379, ui 139/139, web build OK.
- New test verified discriminating: dropping `replace` from the project index `<Navigate>` turns it
  red on the "Back leaves the project" assertion; restored.
- Local Playwright could not launch Chromium (missing system lib `libnspr4`, needs sudo); visual audit
  evidence comes from CI's Playwright Visual Tests job and the staging browser run.
- CI on 43458efb failed only on PR-body wording and a main-branch fixture clock bug (fixed by #2861, merged in).
