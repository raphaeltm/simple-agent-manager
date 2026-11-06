# Installer staging smoke: test under bootstrap consent scopes, and fix its flakes

## Problem

1. **The staging smoke cannot see a consent-scope failure.** `apps/installer/scripts/staging-smoke.ts`
   calls `provision()` with the deployment API token (`CF_API_TOKEN`), which can create Workers and
   Containers. Real users provision with an OAuth token limited to the bootstrap scopes. Until
   `0f72992c2` those were `account-settings.read workers-scripts.edit`, and `workers-scripts.edit`
   is the Workers Editor role, which cannot create Workers. Every real bootstrap install got HTTP
   403 on `PUT /accounts/:account/workers/scripts/:name`, while the smoke stayed green. (The upload
   also declared a builder container, which needs `containers.write`; `dbede9c7d` removed that for
   bootstrap.)
2. **The smoke's owner-handoff check is flaky.** Deploy run 42205126502 failed twice in a row on a
   commit that did not touch the maintenance Worker, then passed on the third attempt:
   - attempt 1: `Owner handoff failed` (claim POST returned non-200; the status is not logged)
   - attempt 2: `Unauthenticated bootstrap expected401; health=500, anonymous=500`
     The same script passed locally at 11:01 UTC against staging with the same code.

## Context

Found 2026-11-06 while debugging the first real OAuth install attempt on staging
(`install.sammy.party`, PR #2475). The 403 was confirmed by the `installer.step_failed` log line
added in `a7586a0a0`.

## Acceptance Criteria

- [ ] The smoke provisions with a credential limited to the bootstrap permissions (for example, a
      temporary account API token with only Workers Scripts Write and Account Settings Read,
      created and deleted by the smoke), so a container declaration or any new permission need
      fails the deploy. This needs a CI credential allowed to create account API tokens; the
      managed staging `CF_TOKEN` returns 9109 on `/tokens`.
- [ ] The claim and health checks log the HTTP status and body kind on failure.
- [ ] The claim step retries only on propagation-type responses (404/503, and 500 if shown to be
      propagation), with a bounded deadline, and never retries an auth regression.
- [ ] Root cause of the health=500 on a freshly uploaded maintenance Worker is identified or shown
      to be propagation.
