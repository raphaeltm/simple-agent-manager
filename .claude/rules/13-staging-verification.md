# Staging Deployment and Live Verification (Hard Merge Gate)

## This Is a Merge-Blocking Requirement

Every PR that changes code MUST:
1. Deploy successfully to staging (the `Deploy Staging` workflow must be green)
2. Be verified on the live staging app using Playwright and test credentials
3. Confirm that the new feature works AND existing workflows are not broken

**No exceptions. No self-exemptions. No "it's just a small change."** If you write code, you deploy it and test it live before merge.

## Staging vs Production Domains

| Environment | Base Domain | App URL | API URL |
|-------------|-------------|---------|---------|
| **Staging** | `sammy.party` | `https://app.sammy.party` | `https://api.sammy.party` |
| **Production** | `simple-agent-manager.org` | `https://app.simple-agent-manager.org` | `https://api.simple-agent-manager.org` |

**Staging is `sammy.party`, NOT `simple-agent-manager.org`.** When verifying PRs, always test against the staging domain.

## Why This Exists

Local tests run against Miniflare mocks. CI runs unit tests in isolation. Neither environment has real OAuth, real DNS, real D1/KV/DO persistence, or real VM infrastructure. Bugs that only manifest in the real Cloudflare environment have shipped to production repeatedly because agents treated staging verification as optional.

## Step-by-Step Procedure

### External Checks That Can Be Ignored

- **SonarCloud Code Analysis** — external third-party service; not a SAM-owned check. Failures here do NOT block merge.

All other checks (CI, Deploy Staging, VM Agent Smoke, Preflight Evidence, etc.) are SAM-owned and MUST pass.

### 1. Staging Deployment Must Be Green

Staging deployment is **manual** — it does NOT run automatically on PRs. You must trigger it yourself:

1. **Check for existing active runs** before triggering:
   ```bash
   gh run list --workflow=deploy-staging.yml --status=in_progress --status=queued --json databaseId,status,createdAt,headBranch
   ```
   If there are active or queued runs, wait at least **5 minutes** from the most recent run's `createdAt` before triggering yours.

2. **Trigger the deployment:**
   ```bash
   gh workflow run deploy-staging.yml --ref <your-branch>
   ```

3. **Watch for completion:**
   ```bash
   sleep 5
   gh run list --workflow=deploy-staging.yml --branch=<your-branch> --limit=1 --json databaseId,status
   gh run watch <run-id>
   ```

If the deployment fails:
- Inspect the deployment logs: `gh run view <RUN_ID> --log-failed`
- Fix the deployment issue in your branch
- Push and re-trigger the deployment
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
   - If the env var is not set, ask the human — do NOT skip this step
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
- **Cannot authenticate** → check that `SAM_PLAYWRIGHT_PRIMARY_USER` env var is set; if not, ask the human — do not skip verification

## Feature-Specific Verification Is Mandatory (Not Just Page Loads)

Staging verification means **exercising the actual functionality the PR changed**, not just confirming pages render. Checking that the dashboard loads after a provider fix is useless — it proves nothing about whether the fix works.

### What "Verify Your Feature" Actually Means

Match the verification to what the PR actually changes:

| PR Changes | Required Verification |
|------------|----------------------|
| Provider/node creation | Create a node using that provider on staging, confirm it provisions and gets healthy |
| IP allocation/backfill | Create a node, confirm it gets a real IP address, confirm DNS resolves |
| Workspace creation | Create a workspace on a node, confirm it's accessible via `ws-*` subdomain |
| Agent installation | Submit a task with that agent type, confirm the agent installs and runs |
| Chat/messaging | Send messages in a project chat, confirm they persist and display |
| Task execution | Submit a task, confirm it progresses through the lifecycle |
| Auth changes | Log out and log back in, confirm the auth flow works end-to-end |
| API endpoint changes | Call the affected endpoints and verify responses |

### What Is NOT Acceptable as Feature Verification

- Confirming pages load (this is a regression check, not feature verification)
- Checking that navigation works
- Verifying no console errors
- "The code changes look correct"
- "Unit tests pass"

These are baseline regression checks. They do NOT verify that the specific fix or feature works on the live environment.

### If You Cannot Verify the Feature

If the feature genuinely cannot be tested on staging (e.g., requires credentials that aren't configured), you MUST:
1. Explicitly state what is blocked and why
2. Ask the human whether to proceed or wait
3. Do NOT merge without human approval for the gap
4. Do NOT substitute page-load checks as if they verify the feature

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
