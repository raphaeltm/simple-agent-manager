# Make the own-account installer path work, simple and tested

Phase 1 of SAM idea `01M84SB68PWK40K6HNB0KX5HRX` (retire the hosted installer). Raphaël decided on
2026-11-23 that people run the installer in their own Cloudflare account, and approved the recommended
route (keep the browser installer, make self-deploy one command) plus one paid test install.

**Out of scope:** retiring `install.simple-agent-manager.org` (Phase 2) and removing bootstrap mode
(Phase 3). This PR must not change what the production installer serves or how it is configured;
the three ways its deploy step itself changes are listed under "Effect on the production installer
deploy" below.

## Problem

The documented way to run the installer in your own account does not work as written, and nothing
tests it.

## Research findings

1. `apps/installer/scripts/deploy.mjs` throws "Full installer mode requires the exact immutable
   GITHUB_SHA" unless a 40-character `GITHUB_SHA` is set. Neither
   `apps/www/src/content/docs/docs/guides/installer.mdx` nor `apps/installer/src/pages/self-host.astro`
   mentions it. → checklist A2.
2. A fresh deploy with the default `INSTALLER_MODE=preserve` is bootstrap-only (cannot install SAM);
   `self-host.astro` omits `INSTALLER_MODE=full`. → A1, D8.
3. `ARTIFACT_BASE_URL` is only set from a GitHub Environment variable, so a self-deployed installer
   never uses prebuilt release artifacts. → A3.
4. A 403 from Cloudflare is reported as "Verify the required API permissions" without naming the
   permission; the self-host funnel review found token-permission 403s were the commonest first-deploy
   failure. → A5.
5. The installer is served at `install.<domain>`, which needs zone permissions (custom domain + route)
   and a route that sits beside SAM's wildcard route. A `workers.dev` origin would need three account
   permissions only (Workers Scripts Write, OAuth Client Write, Account Settings Read; names from
   `apps/installer/tests/fixtures-permission-groups.json`). Whether Cloudflare accepts a `workers.dev`
   client and redirect address for a private OAuth client is unproven: registration is provable in CI,
   the consent screen only by a signed-in account member. → B1–B4, F2.
6. Cloudflare refused OAuth client creation while the client's logo and policy URLs were not yet served
   (comment in `deploy.mjs`, production 2026-11-08). A first `workers.dev` publish can take a moment to
   answer. → B3.
7. There is no way to remove an installer except dashboard clicks. Installations do not need it after
   handoff: `INSTALLER_ORIGIN` is used only for the one-time claim (`apps/installer/src/maintenance.ts`),
   updates read GitHub releases (`apps/installer/src/maintenance-jobs.ts`). → C1.
8. **Unverified:** whether deleting an OAuth client affects account API tokens that were created through
   its grant. Cloudflare's changelog and docs say nothing. The deployment and runtime tokens of an
   installation are created that way (`apps/installer/src/credentials.ts`). → C1 deletes the client only
   on explicit request; F3 checks it; follow-up idea filed before merge.
9. Staging and production deploy through `.github/workflows/deploy-installer.yml` with environment values
   a self-hoster does not have, so findings 1–3 went unnoticed. → E1.
10. Cloudflare supports pre-filled token links
    (https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template). The
    reference table lists `workers_scripts` and `account_settings`; no OAuth client key is listed, and
    user-token links drop unknown keys silently. → D2 lists the permissions by name beside the link, F1
    checks the link.
11. Workspace credentials: `CF_TOKEN` (staging) cannot manage OAuth clients; the BYOC debugging token is
    read-only. Live deploy proof therefore runs in the staging workflow, and the Cloudflare consent step
    needs a person. → E1, F2.
12. Hosted wording to replace: `guides/installer.mdx`, `quickstart.md`, `overview.mdx`, `index.mdx`,
    `guides/self-hosting.mdx` (intro), `guides/recent-product-changes.md`, `architecture/security.md`
    (installer section), `FactoryQuestions.astro`, `enterprise/compliance.astro`, the installer's
    `index.astro`, `self-host.astro`, `privacy.astro`, and `apps/installer/README.md`. The published
    security advisory post stays as written. → D1–D9.

## Design notes (rule 19, external service integration)

- **Self-hoster walkthrough:** create one API token (three account permissions) → clone at a release →
  `pnpm install` → set token and account ID → `pnpm --filter @simple-agent-manager/installer run deploy`
  → open the printed address → Sign in with Cloudflare. No per-installation manual step.
- **Redirect URI:** one static URI per installer, `<origin>/oauth/callback`. No dynamic segments.
- **Threat model:** each installer has its own private OAuth client, which Cloudflare lets only members
  of the owning account authorize. Sessions are host-only cookies on the installer origin;
  `workers.dev` is on the public suffix list, so sibling Workers cannot read them. Two people using one
  installer are both members of that account and each get their own session Durable Object. A leaked
  bootstrap API token can deploy Workers and manage OAuth clients in that account; the docs tell the
  user to delete it after deploying.
- **Constraints:** private clients need no domain verification; public promotion is not used.

## Implementation checklist

### A. Deploy script defaults (`apps/installer/scripts/deploy.mjs`)

- [x] A1. A fresh installer deploys in full mode when `INSTALLER_MODE` is unset or `preserve`; an
      existing installer keeps its mode.
- [x] A2. Source commit: `GITHUB_SHA` when set (still rejected if not 40 hex), else the checked-out
      commit read from Git's files (`scripts/git-head.mjs`; no `git` process, SonarCloud S4036).
      Stop with a clear message when the commit is not on the upstream repository.
- [x] A3. `ARTIFACT_BASE_URL`: explicit value, else the deployed value, else none (build from source);
      `none` opts out. (Changed on 2026-11-26: no release default; see "Policy reconciliation".)
- [x] A4. End by printing the address to open and the next step.
- [x] A5. Name the missing token permission on a refused Cloudflare call, and check account, Workers and
      OAuth access before anything is published.

### B. `workers.dev` origin

- [x] B1. `BASE_DOMAIN` optional: set → `install.<domain>` as today; unset → the deployed origin when an
      installer exists, else `https://<worker>.<account subdomain>.workers.dev`.
- [x] B2. Clear stop when the account has no `workers.dev` address.
- [x] B3. Wait briefly for the freshly published installer to answer before creating its OAuth client.
- [x] B4. Tests for both origins, including preserving an existing custom-domain origin.

### C. Remove command

- [x] C1. `pnpm --filter @simple-agent-manager/installer run remove`: deletes the installer Worker;
      deletes its OAuth client only with `REMOVE_OAUTH_CLIENT=true`; idempotent; never touches
      `sam-maintenance-…` services. Tests.

### D. Docs and copy

- [x] D1. `guides/installer.mdx`: lead with running the installer in your own account; drop hosted
      sections; add removal.
- [x] D2. Token link plus the three permissions by name.
- [x] D3. `quickstart.md`, `overview.mdx`, `index.mdx`, `guides/self-hosting.mdx` intro.
- [x] D4. `guides/recent-product-changes.md`.
- [x] D5. `architecture/security.md` installer section.
- [x] D6. `FactoryQuestions.astro`, `enterprise/compliance.astro`.
- [x] D7. Installer `index.astro`, `privacy.astro` wording.
- [x] D8. Installer `self-host.astro` recipe.
- [x] D9. `apps/installer/README.md`.

### E. Tested documented path

- [x] E1. `deploy-installer.yml` (staging only): run the documented command with no `BASE_DOMAIN`, mode
      or `GITHUB_SHA`, after `remove`, and verify health, pinned commit and the OAuth start redirect.

### F. Live proof (needs a signed-in Cloudflare account member)

- [ ] F1. The token link pre-fills the three permissions.
- [ ] F2. Sign-in, choose, review and handoff work on the staging `workers.dev` installer.
- [ ] F3. After a completed install, removing the installer with its OAuth client leaves the
      installation's tokens working.

## Implementation notes

- **Pushing the task file to `main` is rejected by repository rules**, so it started on the branch.
- **Cloudflare validates an OAuth client and callback before login.** A known client with a registered
  callback is sent to `/login`; a wrong callback or client goes to `/oauth/error` (probed against
  `install.sammy.party` on 2026-11-23). `scripts/check-live.mjs` uses this, so the staging workflow
  proves a `workers.dev` registration is accepted without a signed-in person. This narrows F2 to what
  happens after login.
- **Staging run 45251499394 (first):** the recipe published a fresh installer on `workers.dev`, then
  `POST /oauth_clients` returned 500 five seconds after publish although the runner already got a 200
  from `/health`. The cleanup step's `remove` deleted the Worker and found no client, so a failed
  creation leaves none. Added `createOAuthClient` (time-bounded retry on 5xx, never a second client) and
  Cloudflare's numeric error codes in `ApiFailure`.
- **Staging run 45253061086 (third, commit fe1e52c): all green.** Recipe: remove (nothing there) →
  fresh deploy with no domain, mode or commit → `Installer ready:
https://sam-installer-recipe-check.simple-agent-manager-staging.workers.dev` 8 s after publish →
  `check-live`: commit pinned, full mode, Cloudflare accepts its sign-in client and callback →
  `remove` deleted the Worker and its OAuth client. The existing `sam-installer-staging` deploy and
  its version check passed unchanged afterwards.
- **Real negative check:** running the deploy script locally on an unpushed commit stopped with
  "Commit … is not in raphaeltm/simple-agent-manager" before any Cloudflare write.
- `remove` then `deploy` with a kept OAuth client stops with an actionable "OAuth secret missing"
  message (the secret existed only on the deleted Worker). Documented in the README.
- The security advisory post's link to the renamed guide section was repointed (anchor only).
- `ci.yml` needs no change: `apps/installer/**` and `deploy-installer.yml` are already in its filters.

## Review findings (2026-11-23) and what was done

Six local reviewers ran on commit `9fd7914`. No CRITICAL findings.

- **Unvalidated numeric settings (constitution, HIGH):** a non-numeric timeout made a deadline `NaN`
  and a loop endless. All numeric settings now go through `intFromEnv`
  (`scripts/installer-target.mjs`), which stops the command on anything but a whole number in range.
- **Client-creation bound (constitution, rule 81):** the retry was a count whose stated worst case
  ignored request time. It is now a deadline (`OAUTH_CLIENT_CREATE_TIMEOUT_MS`, default 90 s), and the
  README states the worst case of every wait.
- **Lost client secret (security, LOW):** the client list is re-read before every retry and before
  giving up, including after a dropped connection, so a client whose creation response was lost is
  reported and never duplicated.
- **`ARTIFACT_BASE_URL=none` reverted on the next deploy (security, MEDIUM):** the choice is now stored
  and survives redeploys; `default` goes back. `tests/builder.test.ts` pins that the builder ignores
  the stored value.
- **Default prebuilt artifacts trust mutable release assets (security, MEDIUM): deferred.** The default
  follows Raphaël's 2026-11-07 direction and matches what the production installer already did; the
  guide now states the trust plainly and the opt-out is durable. Verifying the manifest against
  something a release cannot rewrite is a security design change: SAM idea
  `01M85020CSFDKQ7MP0XZRZJ515`.
- **An installer that changes address reused the old client (found while adding the requested test):**
  first handled by giving it a new client, then replaced by refusing the move (see "External review").
- **Docs (doc-sync):** "stops before publishing anything" corrected; existing-client requirements, the
  leftover-route note for `remove`, the permission vocabulary (Edit in the dashboard, Write in the
  API) and the Cloudflare source for the private-client rule added; three more "hosted installer"
  phrases in `self-hosting.mdx` fixed. The security advisory post keeps its wording while the hosted
  installer still exists; Phase 2 updates it.
- **Tests (test-engineer):** added secret-write bodies, absent-secret, address change, failed publish,
  refusal-not-retried, lost-response, input validation, live-check polling and redirect failures, the
  `git-head` traversal case with a planted file, and the command runner. Thirteen guards were deleted
  one at a time and each reddened its test.
- **README:** every variable the scripts read is documented (env-validator).
- Not changed: the inline "Verify deployed version" step of the existing staging/production deploy
  keeps its own 60 s default; replacing it with `check-live` is left for Phase 2, when the production
  path is touched anyway.

## External review (Codex, CodeRabbit) and what changed

- **In-place moves removed.** The review-driven `originChanged` handling (give a moved installer a new
  client) had a failure case either way: keep the old secrets and a failed move looks ready, delete
  them first and a failed publish breaks the old address. An installer is short-lived and has a
  `remove` command, so `deploy.mjs` now refuses to deploy an existing installer at a different address
  and says to remove and redeploy it. Nothing is published or deleted on that path.
- Timing settings are read before the first request and intervals are capped at what a timer can wait;
  every wait goes through `sleepWithin`, so a poll interval cannot outlast its timeout.
- A refusal with an empty or non-JSON body keeps its HTTP status, so it is not retried.
- An explicit OAuth client that belongs to another installer is refused before publishing.
- `git-head.mjs` follows any ref name Git allows and keeps the resolved path under `refs/`.
- The guide's "Remove an installation" lists Container applications.

## Policy reconciliation, 2026-11-26

Project policy `4d205820` (Raphaël, 2026-11-25) requires that installs pull only verifiable code and
artifacts, never an unauthenticated manifest, and the install-path audit (SAM idea
`01M88S2Z10WS855DM0937QVCY2`, HIGH-2) says to build from source by default until the artifacts are
attested. That supersedes the 2026-11-07 direction this PR followed when it made prebuilt artifacts
the default, and the "deferred" entry under "Review findings" above.

- `deploy.mjs` no longer has a default `ARTIFACT_BASE_URL`. A new installer builds everything from the
  pinned source; an explicit https URL opts in; `none` opts out; unset keeps the deployed value. The
  stored `none` marker and the `default` keyword are gone (checklist A3 as first written no longer
  applies).
- `deploy-installer.yml` passes `vars.INSTALLER_ARTIFACT_BASE_URL || 'none'`, so the GitHub Environment
  alone decides for SAM's own installers. Staging does not set it, so the staging installer, which this
  branch's earlier runs had given the release URL, goes back to source builds. Production sets it and
  is unchanged; that pre-existing setting is covered by the audit, not by this PR.
- Guide and README describe prebuilt parts as opt-in and say what turning them on trusts.
- Attestation remains SAM idea `01M85020CSFDKQ7MP0XZRZJ515`.

Also since the reviews: `scripts/staging-smoke.ts` retries its claim and landing requests on 404 and 503
inside the readiness window and reports the status it saw. That existing step failed three times on
this branch (runs 45256673696, 45259366984, 45260693082) without saying what came back.

## Version check behind Cloudflare's bot protection, 2026-11-26

The workflow's existing "Verify deployed version" step failed four times on 2026-11-26 with a bare
"SyntaxError". With diagnostics added (run 45825286606) it reported
`status=403 type=text/html cf-mitigated=challenge`: since 2026-11-24 SAM's zones answer GitHub's
runners with a bot challenge. That is the situation in the open inbox task "Set up a Cloudflare
exception for deploy checks" (PR #3014), whose proposed exception covers the `api.` and `app.` hosts
only, so the installer's address stays challenged. From a non-CI address the installer answered
correctly throughout, and its routes and custom domain were intact.

- `scripts/check-live.mjs` now recognises the challenge and, for that case only, checks what the
  Cloudflare API reports for the deployed Worker (commit, full mode, OAuth secrets) and that the
  custom domain and hostname route lead to it (added after Codex review: a challenge is answered
  before any Worker, so it proves nothing about routing), and says that sign-in was not exercised. Any other non-JSON answer is still a failure and is reported by status
  and content type. The recipe installer on `workers.dev` is not challenged and keeps the full check.
- The workflow's version step now runs `check-live` instead of its own inline script, for staging and
  production alike, so the production installer deploy on `main` is not left red by the challenge.
- Also seen in run 45824462650: sign-in answered 503 a moment after health reported it configured (a
  just-written secret not yet at that edge). `check-live` retries that one status inside its deadline.

## Effect on the production installer deploy

Production keeps `BASE_DOMAIN`, its existing full mode and its existing OAuth client, so origin, mode,
scopes and client are unchanged (`preserve` tests in `apps/installer/tests/deploy.test.ts`). Four
things in its deploy job do change:

1. **Upstream commit check.** Every full-mode deploy now sends one HEAD request to
   `raw.githubusercontent.com` for the pinned commit and stops if it is not there. Production deploys
   run on `main` pushes, whose commit is in the upstream repository by definition. A GitHub outage
   would fail the deploy step; the workflow already depends on GitHub for checkout.
2. **`preview_urls: false`** is now written explicitly. Wrangler's default for `preview_urls` follows
   `workers_dev`, which the script already set to `false` for a custom-domain installer, so nothing
   changes.
3. **`ARTIFACT_BASE_URL`.** Production sets `INSTALLER_ARTIFACT_BASE_URL` in its GitHub Environment
   (read from the GitHub API on 2026-11-23), and the workflow passes that value as before. Staging does
   not set it, so the workflow now passes `none` there.
4. **Version check.** The step runs `check-live`, which also follows the sign-in redirect to
   Cloudflare when the address is reachable, and falls back to the Cloudflare API when the address
   answers the runner with a challenge.

## HELD before merge

F1–F3 need a signed-in member of the Cloudflare account and cannot be done by an agent. The automated
proof stops at Cloudflare's login page. **Do not merge until F1 and F2 are recorded here with evidence,
or Raphaël explicitly waives them.** F3 does not block: `remove` keeps the OAuth client by default, and
the question is tracked in SAM idea `01M84YHD4FZP1C6PXK6AQZMEMM`.

## Acceptance criteria

- [x] On a clean checkout of a commit that is on upstream, the documented command with only
      `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` deploys a full-mode installer pinned to that
      commit, with no prebuilt artifact location, and prints its address (unit tests; staging workflow).
- [x] A commit that is not on upstream stops before anything is published (unit test).
- [x] A refused Cloudflare call names the permission to add (unit tests per permission).
- [x] An existing installer keeps its origin and mode on redeploy (unit tests).
- [x] `remove` deletes only the installer, and the OAuth client only when asked (unit tests; staging
      workflow runs it before each documented-path deploy).
- [x] The production installer keeps its origin, mode, scopes and client (existing tests with explicit
      environment values still pass; deltas listed above).
- [x] Docs describe only what the code does; no page tells people to use a hosted installer.
- [ ] F1–F3 recorded with evidence, or the PR is held with the reason.

## References

- Idea `01M84SB68PWK40K6HNB0KX5HRX`; design history idea `01M60R60ZQT4203MGXAVJNPRH5`.
- `.claude/rules/19-external-service-integration.md`, `30-never-ship-broken-features.md`,
  `62-tests-must-observe-the-real-trigger.md`, `74-proxy-signals-must-match-the-condition.md`,
  `83-no-secret-readback-in-ci.md`.
