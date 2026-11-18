# Installer page copy contradicts shipped email sign-in

## Problem

The hosted installer's own pages still describe the pre-#2597 product:

- `apps/installer/src/pages/index.astro` (hero): "Signing in to SAM afterwards requires GitHub, GitLab
  or Google." Since #2597 a new installation signs its administrator in with an emailed code when
  its email setup succeeds; only if email setup fails does it need a GitHub, Google or GitLab OAuth
  app. The replacement copy must keep that condition.
- `apps/installer/public/app.js` (full-mode note): "Experimental full installation: …". Full mode is
  the production default since #2475 (`INSTALLER_MODE=full`); keep any caution that still applies,
  but name what is actually unverified rather than calling the whole path experimental.
- `apps/installer/README.md` says SAM has no email login and that production leaves
  `INSTALLER_MODE` unset.

## Context

Found on 2026-11-10 while rewriting `apps/www/src/content/docs/docs/guides/installer.mdx` for the
weekly docs update. The public guide now describes email sign-in and the full install flow; the
installer page itself still says otherwise, so a user reading both sees a contradiction.

## Acceptance Criteria

- [ ] The installer hero no longer says sign-in requires GitHub, GitLab or Google
- [ ] The full-mode note reflects the current support status (decide with Raphaël whether the
      "experimental" label stays until the OAuth client is public and his first production install
      is done)
- [ ] `apps/installer/README.md` matches the deployed production mode and email sign-in
- [ ] `apps/installer/tests/browser-audit.ts` screenshots reviewed after the copy change

## Folded in (2026-11-16)

`2026-11-14-installer-pages-say-no-email-login` (doc-sync finding on branch `sam/never-enabled-gitlab-prod-0etcqz`) reported the same stale copy and was archived. Extra locations it named:

- `apps/installer/README.md:9` ("SAM has no email login")
- `apps/installer/src/pages/privacy.astro:35`
- `apps/installer/src/pages/self-host.astro:32`
- `apps/installer/site-static/self-host.html:4`

Added criterion:

- [ ] Each installer page and the README describe sign-in the way `guides/self-hosting.mdx` does (OAuth, or an emailed code when the deploy prepared email).
