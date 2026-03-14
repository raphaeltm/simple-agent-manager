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

The `deploy-staging.yml` workflow runs automatically on every PR. Check its status:

```bash
gh pr checks <PR_NUMBER>
```

The `deploy / Deploy to Cloudflare` check MUST pass. If it fails:
- Inspect the deployment logs: `gh run view <RUN_ID> --job <JOB_ID> --log-failed`
- Fix the deployment issue in your branch
- Push and wait for the re-triggered deployment to succeed
- **A failed staging deployment is the same severity as a failed test — it blocks merge**

### 2. Log In and Verify Using Playwright

After staging deployment succeeds, use Playwright to test the live app:

1. Navigate to `https://app.sammy.party` (staging)
2. Authenticate using test credentials at `/workspaces/.tmp/secure/demo-credentials.md`
   - If the file is missing, ask the human for credentials — do NOT skip this step
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
- **Cannot authenticate** → ask the human for credentials, do not skip verification

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
