# Installer: reinstalling over a removed install fails on leftover resources

## Problem

Reinstalling SAM into an account and zone where a previous install was partly removed
fails mid-way. Two leftovers blocked it on 2026-11-09:

- A Workers route `*.vm.${domain}/*` with no script. Preflight refused with "Existing
  Workers routes block installation".
- The previous Pages project (`${prefix}-web-prod`), which still owned `app.${domain}`.
  `pulumi up` failed in the `infrastructure` phase after creating 19 of 23 resources.

The installer's UI showed only a generic failure. The job record (`installer/jobs/*/state.json`
in the builds bucket) holds phase timings but no error text, and the maintenance Worker does
not write to Workers Observability.

## Context

Found while preparing the live onboarding run for PR #2610 on the sam2.party test account,
after a manual cleanup that missed the route and the Pages project.

## Acceptance Criteria

- [ ] Preflight lists every leftover from a previous install of the same prefix: Workers
      routes, Pages projects or domains, Workers, D1, KV, R2, containers and tokens. It
      offers to adopt or remove them, or names them clearly
- [ ] A failed phase stores its error tail in the job record, so it can be read after the fact
- [ ] The self-hosting guide documents a complete uninstall
