# Staging Deployment and Live Verification (Hard Merge Gate)

## Read First: Local-First Development Applies

Before you reach this rule, you should already have exhausted local verification per `.claude/rules/29-local-first-debugging.md`. Staging is the **final integration gate**, not the development environment. If you're about to deploy to staging for the first time, ask yourself: "Have I proven every piece of this locally that CAN be proven locally?" If not, go back.

If staging behavior is wrong, **READ THE LOGS before changing any code** — never guess-and-redeploy. See Rule 29 for the log location matrix (wrangler tail, `/admin/logs`, node `LogsSection`, `journalctl`, `docker logs`).

## This Is a Merge-Blocking Requirement

Every PR that changes code MUST:

1. Deploy successfully to staging (the `Deploy Staging` workflow must be green)
2. Be verified on the live staging app using Playwright and test credentials
3. Confirm that the new feature works AND existing workflows are not broken

**No exceptions. No self-exemptions. No "it's just a small change."** If you write code, you deploy it and test it live before merge.

## Staging vs Production Domains

| Environment    | Base Domain                | App URL                                | API URL                                |
| -------------- | -------------------------- | -------------------------------------- | -------------------------------------- |
| **Staging**    | `sammy.party`              | `https://app.sammy.party`              | `https://api.sammy.party`              |
| **Staging 2**  | `sammy2.party`             | `https://app.sammy2.party`             | `https://api.sammy2.party`             |
| **Production** | `simple-agent-manager.org` | `https://app.simple-agent-manager.org` | `https://api.simple-agent-manager.org` |

**Staging is `sammy.party`, NOT `simple-agent-manager.org`.** When verifying PRs, always test against the staging domain.

## Two Staging Installations

There are two staging installations. Both run with the `staging` GitHub Environment's
credentials, in the same Cloudflare account. Each has its own Workers, D1, KV, R2, Pages, DNS
zone, Pulumi stack, users and data. They share the Pulumi state bucket (separate stacks), the
account's workers.dev subdomain and the Hetzner account.

| Installation | App                        | API                        | Prefix / stack      |
| ------------ | -------------------------- | -------------------------- | ------------------- |
| `staging`    | `https://app.sammy.party`  | `https://api.sammy.party`  | `sam` / `staging`   |
| `staging2`   | `https://app.sammy2.party` | `https://api.sammy2.party` | `sam2` / `staging2` |

**Choosing one.** Read the queue of both (`node scripts/deploy/staging-lease.mjs status staging`
and `... status staging2`) and reserve the one that is free or has the shorter queue. Each
installation has its own lease and queue, its own concurrency groups and its own data, so two
agents can verify at the same time. Deploy with
`gh workflow run deploy-staging.yml --ref <branch> -f environment=staging2 -f sam_task_id=<id>`
(omit `environment` for `staging`). Storage activation and the agent-email DNS audit are
primary-only, and so is the signed GitHub-trigger audit (staging2 has no GitHub App). The
shared deployment engine (`use_shared_engine`) is not supported for staging2. A `staging2` GitHub Environment exists only because lease records are kept per
installation; it holds no secrets and must not get any (staging2's jobs run with `staging`).

**The staging2 account to use.** Since 2026-11-17 the working account is
`test-user@simple-agent-manager.org` (user `staging2-test-user`, superadmin). Raphaël added its
own credentials by hand: a Claude Code OAuth credential, a GCP cloud credential, and a platform
`google-infrastructure` integration. Run sessions and VMs as that user. The two bootstrap users
(`staging2-agent-admin`, `staging2-agent-user`) have no credentials of their own.

**Signing in to staging2.** Use workload identity; no separate token exists for staging2.
Audience `https://api.sammy2.party/api/auth/workload-identity-login`; target `staging2-test-user`
once the trust names it, otherwise `staging2-agent-admin` (superadmin) or `staging2-agent-user`.
Add the returned cookie for `.sammy2.party`. The issuer and allowed source project/user are the
same as for `staging`.

The trust comes from the `staging` Environment's GitHub secret `AGENT_SIGN_IN_TRUST_STAGING2`, which
Raphaël sets by hand: staging's issuer and source, with `allowedTargets`
`["staging2-agent-admin","staging2-agent-user","staging2-test-user"]`. Deploys pass it straight to
`configure-secrets.sh` as `SECONDARY_AGENT_SIGN_IN_TRUST`, in the same bulk secret write, and never
derive it from staging's trust. The first staging2 deploy after the secret is set (and PR #2841 is
on the deployed ref) applies it. Before that, the Worker value from earlier deploys names only the
two bootstrap users, so signing in as `staging2-test-user` returns 403. While the secret is unset,
a deploy leaves staging2's Worker secret as it is (`AGENT_SIGN_IN_TRUST_KEEP_WHEN_UNSET`), so
staging2 is never left without a trust; revoking it therefore also means deleting the Worker
secret by hand.

The staging smoke token works on staging2 only where a registration row already exists (the
one made before 2026-11-17 does). Deploys no longer register it, because that needs staging2's
`ENCRYPTION_KEY` in the runner. When staging2 refuses the token, the deploy's smoke tests are
skipped with a warning.

**What a fresh staging2 has.** The deploy seeds only what needs no secret value
(`scripts/deploy/bootstrap-staging-installation.ts`, secondary installations only): the two
bootstrap users above, both opted into the SAM AI proxy for Claude Code (`providerMode: sam`).
It never reads a Pulumi secret, decrypts a credential, or copies anything from `staging` (policy
795e72a6, `.claude/rules/83-no-secret-readback-in-ci.md`). A human (Raphaël) sets up the rest by
hand, once per installation:

1. Sign in as `test-user@simple-agent-manager.org`. On a rebuilt installation, add that user
   first, as superadmin, in the D1 console. Then add its credentials (Claude Code, GCP) and the
   Google infrastructure integration.
2. Admin → Infrastructure: pick the shared pool's machines, at most 2 nodes.
3. GitHub → Environments → `staging`: the `AGENT_SIGN_IN_TRUST_STAGING2` secret described above.

Earlier deploys copied some rows into staging2 by the old, now removed path: platform
credentials `staging2-bootstrap-cloud` (Hetzner) and `staging2-bootstrap-agent-claude-code`, the
smoke token `staging2-bootstrap-smoke-token`, and the pool machines. Those rows are still in
place; deleting them is Raphaël's call. A teardown removes everything, and the steps above must
then be repeated: file an inbox item for Raphaël before tearing staging2 down, and do not expect
a rebuilt staging2 to run VMs or agent sessions on its own. There is no GitHub App: use
Artifacts-backed projects.

**Querying staging2 directly.** Same account and `$CF_TOKEN` as staging. Look the D1 id up by
name (`sam2-staging2`): `GET /accounts/$CF_ACCOUNT_ID/d1/database?name=sam2-staging2`.

**Teardown.** Actions → Teardown → `staging2` → `DELETE`. It touches only `sam2-*` resources,
the `staging2` Pulumi stack and the `sammy2.party` zone's workspace and node records. Delete test workspaces and
nodes first; teardown does not delete VMs. The next deploy rebuilds staging2 with only its two
users. Credentials, pool and smoke token then need Raphaël's manual setup again (above).

**Branches that add a Durable Object migration.** Durable Object migrations only move forward.
Once a branch deploys a tag that `origin/main` lacks (a new `[[migrations]]` entry in
`apps/api/wrangler.toml`), every main-based branch fails the migration preflight on that
installation until the branch merges. So `deploy-staging.yml` refuses such deploys on primary
`staging` before reserving a place (`scripts/deploy/staging-migration-guard.mjs`, which fails closed
when it cannot compare the two files; it runs from your branch's workflow copy, so branches must
include it, and the deploy-time migration preflight stays the backstop). Use `staging2`. Clean-up duty: if your branch has not merged
when you are done on `staging2`, tear it down (Actions → Teardown → `staging2` → `DELETE`, after
deleting test workspaces and nodes) and redeploy `main` to it (`gh workflow run deploy-staging.yml
--ref main -f environment=staging2 -f sam_task_id=<id>`) before you release. staging2 rebuilds
from nothing, so main-based branches can use it again. Teardown erases the manual setup above
(credentials, pool, sign-in trust Worker value), so file an inbox item asking Raphaël to redo it;
until he does, staging2 cannot run VMs or agent sessions. Nothing does this automatically.

Adding a third: one entry in `scripts/deploy/staging-installations.mjs` plus a zone in the
staging Cloudflare account that the staging deploy token can edit.

## Why This Exists

Local tests run against Miniflare mocks. CI runs unit tests in isolation. Neither environment has real OAuth, real DNS, real D1/KV/DO persistence, or real VM infrastructure. Bugs that only manifest in the real Cloudflare environment have shipped to production repeatedly because agents treated staging verification as optional.

## Step-by-Step Procedure

### All CI Checks Must Pass

All checks — including **SonarCloud Code Analysis** — MUST pass before merge. SonarCloud provides valuable feedback on code quality, duplication, and potential bugs. Treat its findings the same as any other CI failure: investigate, fix, and only merge when green.

GitHub may label some checks as informational, advisory, or not strictly required by branch protection. If the check is red or reports failure, agents must still treat it as a real merge blocker. Failed PR Evidence, SonarCloud, lint-adjacent, quality, or evidence checks must be inspected and resolved before merge. Do not summarize them away as "non-blocking" unless the repository explicitly documents that exact check as non-blocking or a human explicitly approves the exception in the PR.

### 1. Staging Deployment Must Be Green

Staging deployment is **manual** — it does NOT run automatically on PRs. You must trigger it yourself:

1. **Read the queue of both installations** (one `gh api` call each):

   ```bash
   node scripts/deploy/staging-lease.mjs status staging2   # and: status staging
   # Raw records, newest first (a `snapshot` plus newer `reservation` events):
   gh api 'repos/raphaeltm/simple-agent-manager/deployments?environment=staging2&task=staging-lease&per_page=100' \
     --jq '[.[] | {id, payload}]'
   ```

   `status` prints the holder, whether the slot is free, and the ordered queue
   (branch, SAM task ID, reserved-at, turn window). There are two staging
   installations, `staging` (`sammy.party`) and `staging2` (`sammy2.party`); pick the
   one that is free or has the shorter queue and use that name in every command
   below. They share the `staging` credentials but nothing else. staging2 sign-in is
   workload identity only; see "Two Staging Installations" in the full reference.

2. **Reserve first, then deploy only on your turn.** Reserving takes seconds and
   deploys nothing:

   ```bash
   gh workflow run deploy-staging.yml --ref <your-branch> \
     -f environment=staging2 -f lease_action=reserve -f sam_task_id=<your-task-id>
   ```

   The run summary shows your position and estimated turn. When the slot is free
   (holder released, or its lease expired), only the head of the queue may take it,
   for `STAGING_LEASE_GRACE_MINUTES` (default 10); if it does not, the next entry
   gets its own grace period and the missed one is dropped. If the holder released
   early, the head's turn still lasts until the holder's announced expiry plus grace.
   Schedule a one-time SAM wake (`schedules_write`, method `create`,
   `message_session` for your session) at your turn start, persist the schedule ID,
   and end the turn or do independent work. Do not poll, and **never dispatch a
   deploy while another branch holds the lease or it is another branch's turn**: the
   run is refused (your place is kept). A reservation expires after
   `STAGING_LEASE_RESERVATION_MINUTES` (default 480) unless renewed by reserving
   again, which keeps your place. While the holder is a branch whose workflow predates
   the queue (its lease record is version 1), no reservation is written, because its
   workflow cannot read queue records and would be locked out of its own lease:
   schedule a wake at its expiry and reserve then.

   On your turn, deploy (or `-f lease_action=acquire` to hold without deploying):

   ```bash
   gh workflow run deploy-staging.yml --ref <your-branch> \
     -f environment=staging2 -f sam_task_id=<your-task-id> -f lease_hold_minutes=30
   ```

   A deploy dispatch also reserves if you are not queued yet, and goes straight
   through when the slot is free and nobody is waiting. The `queue` job records
   places outside any concurrency group, so no later dispatch can cancel your place;
   only a branch that holds the lease or whose turn it is reaches the serialized
   `lease` job. Same-branch redeploys renew the lease. Expiry is acquisition time
   plus expected deployment time (`STAGING_LEASE_EXPECTED_DEPLOY_MINUTES`, default
   30; zero for `acquire`) plus the live-check hold
   (`STAGING_LEASE_DEFAULT_HOLD_MINUTES`, default 30, capped by
   `STAGING_LEASE_MAX_HOLD_MINUTES`, default 120). Failed or cancelled runs keep the
   lease until release or expiry.

3. **Watch the run.** Keep the lease through every live check (section 2 below, and the
   infrastructure checks where they apply); then **release** and hand over:

   ```bash
   gh run list --workflow=deploy-staging.yml --branch=<your-branch> --limit=3 \
     --json databaseId,status,conclusion,headSha
   gh run watch <run-id>
   ```

   After every live check and test-resource cleanup:

   ```bash
   gh workflow run deploy-staging.yml --ref <your-branch> \
     -f environment=staging2 -f lease_action=release -f sam_task_id=<your-task-id>
   ```

   Confirm the release run passed and `status` shows no holder. Release also
   removes you from the queue if you were waiting. A branch that releases and wants
   the slot again queues behind everyone already waiting. **If you release early,
   message the next task in the queue** (`send_durable_message` to its SAM task ID
   from `status`) so it can take its turn before its scheduled wake. Successful
   deployment completion is not a release. Release only after your own deploy run
   has finished: the next holder's deploy waits for an in-flight one in the
   `staging-apply-<installation>` group, but your live checks are no longer
   protected once you release.

   Records are GitHub deployments with task `staging-lease`, keyed by installation.
   A malformed snapshot or an unknown record version fails closed (no one can
   change the lease until it is fixed through a reviewed change; never delete
   history to get around another branch); a malformed reservation is skipped and
   reported in the run. Branches whose workflow copy predates the queue are refused
   by every queue record ("Malformed lease record"): they cannot reserve, deploy,
   acquire or release until they update from `origin/main`. Only the `queue` and
   `lease` jobs receive `deployments: write`; lease writes must go through the
   workflow.

For container-backed Instant verification, `wrangler deploy` success means the
rollout started, not that every instance serves the new image. The shared staging
and production workflow has a separate **Wait for container rollout completion**
step. It compares rollout identities before/after deploy, pins the single new
rollout and requires all its steps completed through 100% at the pinned target.
The application list can retain the previous version after completion; that
disagreement is diagnostic and does not veto the completed rollout.
Multiple new rollouts fail as ambiguous. An unchanged or metadata-only deployment
awaits any existing pending rollout; a first direct creation needs no rollout.
Application GET can report the old version during rollout, so version equality
alone cannot prove a no-op. API errors, unreadable status and timeout fail the
step. This closes the window where deploy reports success mid-rollout; it does
not prove every running instance's binary. The unexplained post-rollout version
transition remains tracked in idea01M7BQJ14BKVMPMKRA2GCSP8MJ. Keep gradual rollouts: even one 100% step has a mixed-image window while
instances are replaced. After workflow success, verify the new Instant node's
recorded `agent_version` matches the deployed `VM_AGENT_REQUIRED_VERSION` before
counting a VM-agent trial as evidence. The authenticated `/ready` callback logs
`instant_session.agent_version_mismatch` with nodeId, expectedVersion and
reportedVersion without rejecting readiness; `/health` only reports liveness.

Deploy-only GitHub Environment overrides (not Worker runtime settings):
`CONTAINER_ROLLOUT_TIMEOUT_MS` defaults to 1200000 (20 minutes), and
`CONTAINER_ROLLOUT_POLL_INTERVAL_MS` defaults to 10000. Both require positive
integer milliseconds. Timeout diagnostics include application, rollout and last
status. These settings do not change the rollout strategy.

If the deployment fails:

- Inspect the deployment logs: `gh run view <RUN_ID> --log-failed`
- **Distinguish code failures from configuration failures:**
  - **Code failure** (build error, type error, test failure): Fix the issue in your branch, push, and re-trigger
  - **Configuration failure** (missing secrets, missing environment variables, permissions errors): first distinguish manual prerequisites from generated platform secrets. Generated platform secrets should come from Pulumi/configure-secrets and should be fixed in code/config when that path is broken. For true missing user-owned GitHub Environment secrets or Cloudflare credentials, **alert the user immediately** with the exact missing item and action required. Do NOT skip staging verification because of a config failure — do NOT merge without it.
- **Check for pre-existing deploy failures** before assuming your code broke it:
  ```bash
  gh run list --workflow=deploy-staging.yml --limit=5 --json conclusion,createdAt,displayTitle
  ```
  If the last several staging deploys have all failed with the same error, this is a systemic issue — **alert the user** that staging deployments are broken and require intervention. Do not rationalize around it ("my code is fine, it's just a config issue") — a broken staging pipeline is a broken merge gate.
- **A failed staging deployment is the same severity as a failed test — it blocks merge**

### 2. Log In and Verify Using Playwright

After staging deployment succeeds, use Playwright to test the live app:

1. Authenticate using the smoke test token via the token-login API:

   ```typescript
   // In Playwright, use page.request to POST to the token-login endpoint.
   // This sets the session cookie on the browser context automatically.
   const loginResp = await page.request.post('https://api.sammy.party/api/auth/token-login', {
     data: { token: process.env.SAM_PLAYWRIGHT_PRIMARY_USER },
     headers: { 'Content-Type': 'application/json' },
   });
   // Verify login succeeded (status 200, response has success: true)
   ```

   - The `SAM_PLAYWRIGHT_PRIMARY_USER` env var contains the smoke test token
   - The `SAM_PLAYWRIGHT_*` tokens are staging tokens. They must be exchanged by Playwright against `https://api.sammy.party`, not `SAM_API_URL`.
   - Do not use SAM CLI login as the normal staging verification path. The required flow is browser auth through Playwright, then browser navigation to `https://app.sammy.party`.
   - If the env var is not set, ask the human — do NOT skip this step

   **Alternative: sign in with your workload identity (no stored token).** When staging is
   configured to trust production (`AGENT_SIGN_IN_TRUST` in the `staging` GitHub Environment),
   an agent running in the SAM project on production can sign in as the staging smoke-test user
   without `SAM_PLAYWRIGHT_PRIMARY_USER`. Guide: `apps/www/src/content/docs/docs/guides/agent-sign-in.md`.

   Staging trusts:

   | Value          |                                                                  |
   | -------------- | ---------------------------------------------------------------- |
   | Issuer         | `https://api.simple-agent-manager.org/oidc`                      |
   | Source project | `01KHRJGANBBWGDY1NZ0KVF0D4J` (SAM)                               |
   | Source user    | `4bw1FJlXCOgSGq0TsQgpiMAhQKjGOSXx` (chats owned by this user)    |
   | Target         | `toWzGjNW3IyUkCVItRQv3qSn0wI8c22y` (the staging smoke-test user) |
   | Audience       | `https://api.sammy.party/api/auth/workload-identity-login`       |

   a. Exchange a token (one `exec_with_secrets` call; the token never appears in output):

   ```json
   {
     "shell": "bash",
     "secretNames": [],
     "oidc": { "audience": "https://api.sammy.party/api/auth/workload-identity-login" },
     "command": "printf '{\"token\":\"%s\",\"target\":\"%s\"}' \"$SAM_OIDC_TOKEN\" toWzGjNW3IyUkCVItRQv3qSn0wI8c22y | curl -sS --fail-with-body https://api.sammy.party/api/auth/workload-identity-login -H 'content-type: application/json' --data-binary @-"
   }
   ```

   b. In Playwright, add the returned `sessionCookie` (`__Secure-better-auth.session_token=VALUE`)
   for `.sammy.party` and open the app:

   ```js
   await page.context().addCookies([
     {
       name: '__Secure-better-auth.session_token',
       value: 'VALUE',
       domain: '.sammy.party',
       path: '/',
       httpOnly: true,
       secure: true,
       sameSite: 'Lax',
     },
   ]);
   await page.goto('https://app.sammy.party');
   ```

   c. Clean up before signing out: stop and delete deployments, workspaces and nodes you created for the test, unless the person who asked wants to look at them (then say they are still running).
   d. Sign out when finished (`POST https://api.sammy.party/api/auth/sign-out` from the browser context, with `origin: https://app.sammy.party`). Each token works once (request a new one per
   sign-in); the session lasts one hour. A `404` means staging is not configured for it; fall
   back to the stored smoke token. Production must never carry `AGENT_SIGN_IN_TRUST`.

2. Navigate to `https://app.sammy.party` (staging) — the session cookie from step 1 authenticates you
3. Verify your changes work as intended (see verification checklists below)
4. Verify existing core workflows still work (see regression checklist below)

### 3. Report Evidence

Include verification evidence in the PR description or as a comment:

- Screenshots from Playwright for UI changes
- API response verification for backend changes
- Console error checks (no new errors in browser console)
- Specific flows tested and their outcomes

## Verification Checklists

### For ALL Code Changes (Regression Check)

Every PR must verify these existing workflows are not broken:

- [ ] App loads without errors at `https://app.sammy.party`
- [ ] Dashboard renders with project cards visible
- [ ] Can navigate to a project page
- [ ] Settings page loads and displays current configuration
- [ ] No new console errors in the browser developer tools
- [ ] API health endpoint responds: `https://api.sammy.party/health`
- [ ] Observability noise check passes: `pnpm quality:observability-noise` (requires `CF_TOKEN`, `CF_ACCOUNT_ID`; optionally `OBSERVABILITY_DB_ID`)

### For UI Changes (Additional)

- [ ] Changed pages/components render correctly
- [ ] Interactive elements respond to clicks, form submissions, navigation
- [ ] Data displays accurately (lists, details, status indicators)
- [ ] Mobile/responsive layout is acceptable
- [ ] No layout breaks on pages adjacent to the changed components

### For API/Backend Changes (Additional)

- [ ] Affected API endpoints respond correctly
- [ ] Data persists and loads correctly through the UI
- [ ] Background processes (DOs, cron jobs) function as expected
- [ ] Error handling returns appropriate responses (not 500s or raw errors)

### For Infrastructure/Agent Changes (Additional)

- [ ] Workspace creation and lifecycle operations work
- [ ] VM agent heartbeats arrive at the control plane
- [ ] WebSocket connections establish and maintain
- [ ] Agent sessions start and communicate correctly

## What "Verify Existing Workflows" Means

It is NOT enough to only test the feature you changed. You must also actively use the product to confirm you haven't broken something else. This means:

1. **Navigate the app** — click through dashboard, projects, settings
2. **Check data loading** — do lists populate? Do details pages show data?
3. **Test interactions** — can you still create things, navigate, use forms?
4. **Watch for errors** — browser console, network failures, blank pages

If you find a bug unrelated to your PR, file it as a backlog task (`tasks/backlog/YYYY-MM-DD-descriptive-name.md`) and continue — but do NOT ignore it.

## Failures Block Merge

- **Staging deployment fails** → fix the deployment, do not merge
- **App doesn't load** → fix the issue, do not merge
- **Your feature doesn't work on staging** → fix the issue, do not merge
- **Existing workflow is broken** → investigate whether your PR caused it; if yes, fix it; if pre-existing, file a backlog task but still do not merge with NEW regressions
- **Cannot authenticate** → check that `SAM_PLAYWRIGHT_PRIMARY_USER` env var is set and that Playwright is posting to `https://api.sammy.party/api/auth/token-login`; if you accidentally use production (`api.simple-agent-manager.org`) the staging token will fail with `401 Invalid token`. If the env var is missing, ask the human — do not skip verification.

## Feature-Specific Verification Is Mandatory (Not Just Page Loads)

Staging verification means **exercising the actual functionality the PR changed**, not just confirming pages render. Checking that the dashboard loads after a provider fix is useless — it proves nothing about whether the fix works.

### What "Verify Your Feature" Actually Means

Match the verification to what the PR actually changes:

| PR Changes             | Required Verification                                                                |
| ---------------------- | ------------------------------------------------------------------------------------ |
| Provider/node creation | Create a node using that provider on staging, confirm it provisions and gets healthy |
| IP allocation/backfill | Create a node, confirm it gets a real IP address, confirm DNS resolves               |
| Workspace creation     | Create a workspace on a node, confirm it's accessible via `ws-*` subdomain           |
| Agent installation     | Submit a task with that agent type, confirm the agent installs and runs              |
| Chat/messaging         | Send messages in a project chat, confirm they persist and display                    |
| Task execution         | Submit a task, confirm it progresses through the lifecycle                           |
| Auth changes           | Log out and log back in, confirm the auth flow works end-to-end                      |
| API endpoint changes   | Call the affected endpoints and verify responses                                     |

### What Is NOT Acceptable as Feature Verification

- Confirming pages load (this is a regression check, not feature verification)
- Checking that navigation works
- Verifying no console errors
- "The code changes look correct"
- "Unit tests pass"
- **For browser-consumed streams (SSE / WebSocket): using `curl` to verify that
  bytes arrive on the wire.** Curl confirms the _byte stream_; only a real
  browser confirms _dispatch_ to the client-side handler (`EventSource.onmessage`
  or `WebSocket.onmessage`). A server can emit perfectly valid SSE that the
  browser parses and then silently drops because nothing is listening for the
  specific event name. See
  the retained incident lesson in this rule.
- **For browser-consumed streams that update React/query-cache state: confirming
  that a browser received a frame, but not that the receiving browser's visible
  UI converged.** If the production path can deliver the same domain event over
  multiple client sockets or hooks, tests and staging verification must exercise
  the exact socket/hook that receives the production frame and assert the
  downstream cache or DOM changes. At minimum, cover create/update/status-only
  event variants in the receiving browser without a reload.

These are baseline regression checks. They do NOT verify that the specific fix or feature works on the live environment.

### If You Cannot Verify the Feature (Credential / Config Blocker)

If the feature genuinely cannot be tested on staging (e.g., requires credentials, secrets, or infrastructure that aren't configured), you MUST:

1. **Do NOT merge.** A feature that cannot be verified cannot ship.
2. **Add a comment on the PR** explaining exactly what is missing (credential name, secret, service) and what needs to be configured.
3. **Notify the human via `request_human_input`** (SAM MCP tool) with a clear description of the blocker and what action is needed.
4. **Label the PR `needs-human-review`** so it is visible in the PR list.
5. **Stop.** The human decides whether to configure the missing piece and retry, or defer the feature.
6. Do NOT substitute page-load checks as if they verify the feature.

"Missing credentials" is never a valid reason to skip feature verification — it means the feature is **untestable**, which means it is **unshippable**. This applies even if the UI renders correctly, API endpoints respond, and unit tests pass.

#### Incident Reference

On 2026-04-26, PR #823 (SAM Agent Phase A) was merged after the agent rationalized: "End-to-end chat requires a configured Anthropic platform credential... the chat would return a graceful error." The agent verified page loads and API responses but never sent a chat message. The feature was completely broken in production (TransformStream deadlock, zero bytes streaming). The correct action was to stop and ask the human to configure the credential.

### Testing Platform-Funded AI Without a Real AI Key

A missing platform AI key is not a reason to skip verifying AI metering, daily token budgets or
monthly spending limits. On an installation without an AI Gateway (the self-host box), turn on the
test-only fake upstream (`apps/api/src/services/ai-test-upstream.ts`; reference:
`apps/www/src/content/docs/docs/reference/configuration.md`, "Test-only fake AI upstream"):

1. Deploy with the Worker var `AI_TEST_UPSTREAM_ENABLED=true`: on the box, a line in
   `deploy/selfhost/.state/secrets.env` (mode 0600, created with a NORMAL umask in a separate
   shell from any upgrade: a restrictive umask leaks into `selfhost:upgrade`'s checkout and breaks
   the key agent), then `pnpm selfhost:deploy`. Only staging/test/self-host `ENVIRONMENT`s honour it.
2. In Admin settings, set `aiProxy.directUpstreamEnabled=true`, add your **test user's id** to
   `aiProxy.testUpstreamUserIds`, and set `aiProxy.testUpstreamCostPerCallCents` (default 40).
   Only listed users are faked; everyone else keeps the real model.
3. Drive real `sam`-mode calls from a workspace of that user (or with its callback token against
   `/ai/v1/chat/completions`, `/ai/v1/responses`, `/ai/anthropic/v1/messages`). Use a catalog model
   whose output price keeps the test under the daily output budget (an Opus model: $0.40 is about
   16k output tokens). Replies contain `SAM test upstream: canned reply`.
4. The check runs before each call against spend so far: with a $1 cap, $0.40 calls make the 4th
   call return 429 `rate_limit_error` ("Administrator monthly AI spending limit reached" when the
   admin ceiling binds). $0.30 calls make the 5th the refused one.
5. Read the spend from `GET /api/usage/ai/budget` or Settings > Usage (`monthCostUsd`).
6. Clean up: reset `aiProxy.testUpstreamUserIds` and the ceiling, then delete the `secrets.env`
   line and run `pnpm selfhost:deploy --unset AI_TEST_UPSTREAM_ENABLED` (on a sealed box, deleting
   the line alone keeps the sealed value). The listed user's fake spend stays in their counters for
   the month.

An installation with an AI Gateway (staging, production) does not use the in-process fake: its
spend comes from gateway logs, which an in-process answer never reaches. Real agents make several
calls per turn, some concurrently; concurrent calls admitted before earlier spend is recorded can
each overshoot the cap by their own cost (documented behaviour), so count by spend, not by turns.

## Zero Errors During Feature Verification (ABSOLUTE)

When you exercise the feature on staging, **any error is a merge blocker**. This includes:

- API errors (4xx, 5xx) during the feature flow
- Error toasts, error banners, or error states in the UI
- Console errors related to the feature
- "Not configured" or "not available" messages
- The feature silently doing nothing when it should do something

**You do NOT get to decide that an error is "expected" or "not relevant."** If the feature errors when a user tries to use it, the feature is broken. Period.

### Banned Rationalizations

If you catch yourself thinking any of these during staging verification, STOP — you are about to ship broken code:

- "The error is expected because [infrastructure/config/tooling] isn't set up yet" → The feature isn't ready. Don't merge.
- "The config endpoint returns the right value, which is the main change" → The main change is the FEATURE. Verify the feature.
- "This will work once [X] is upgraded/configured separately" → It doesn't work NOW. Don't ship NOW.
- "I verified the components work individually" → Components working individually ≠ feature working end-to-end.

See `.claude/rules/30-never-ship-broken-features.md` for the full anti-rationalization rule and the incident that created it.

## No Self-Exemptions

- "It's just a docs change" → if you changed ANY `.ts`, `.tsx`, `.go`, or other runtime code, you verify
- "It's just a refactor with no behavior change" → prove it by verifying on staging
- "The tests pass" → tests passed for the TLS YAML bug too; staging is the real gate
- "Staging is currently broken by something else" → distinguish your changes from pre-existing issues; your PR must not make it worse
- "This is the fix for the broken staging" → that's the STRONGEST reason to verify — confirm your fix actually works

## PR Template Checkboxes

The PR template includes mandatory staging verification checkboxes. These are not ceremonial — they represent actual verification that was performed:

- `Staging deployment green` — the Deploy Staging workflow passed
- `Live app verified via Playwright` — you logged in and tested
- `Existing workflows confirmed working` — you checked regression items
- `New feature verified on staging` — your specific changes work live
