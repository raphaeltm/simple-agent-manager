# Installer pages still say SAM has no email login

## Problem

SAM supports emailed sign-in codes (documented in `apps/www/src/content/docs/docs/guides/self-hosting.mdx`
and `overview.mdx`), but the installer's own copy still says it does not:

- `apps/installer/README.md:9` ("SAM has no email login")
- `apps/installer/src/pages/privacy.astro:35`
- `apps/installer/src/pages/self-host.astro:32`
- `apps/installer/site-static/self-host.html:4`

New self-hosters reading the installer pages are told the opposite of what the product does.

## Context

Found by the doc-sync reviewer on the setup-takeover fix PR (branch
`sam/never-enabled-gitlab-prod-0etcqz`, 2026-11-14). Pre-existing, outside that PR's scope.

## Acceptance Criteria

- [ ] Each installer page and the README describe sign-in accurately: GitHub, Google or GitLab OAuth,
      or an emailed sign-in code when the deploy prepared email
- [ ] Wording matches `guides/self-hosting.mdx`
- [ ] Installer build and its browser audit still pass
