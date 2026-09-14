# Marketing site refresh: new feature pages, homepage copy, mock-data screenshots

**SAM task:** 01M2G89JCFTPMFQ9WQWBSS8VBF
**Branch:** `sam/marketing-site-feature-pages-ss8vbf` (single **draft** PR — do not merge; merging `apps/www/**` to main deploys the live site via `deploy-www.yml`)
**Status:** in progress — draft PR #2082; site + specs + images committed (03d1f50d7); local ui-ux-specialist review addressed (2 HIGH, 3 MEDIUM); evidence + PR finalized (2026-09-14 18:05Z). Awaiting Raphaël's review; do not merge.

## Goal

Bring `apps/www` (marketing site) up to date with the product. Add feature pages and homepage
coverage, with screenshots generated from the real `apps/web` UI using mocked API data, for:

1. Multiplayer projects (invite links, access requests, members/roles, shared profiles/skills/secrets, all-sessions view, credential attribution, offboarding)
2. Comments on files and conversations (message + library-file threads, project Comments inbox, send-to-agent directive, resolve/reopen)
3. Compute pools spanning cloud providers (project/user/installation scopes, provider-native offerings, strategy, exhaustion policy, resource requirements, placement decision) **and** every reporting surface for compute + token usage that actually exists in the app
4. Event streams and triggers (cron + GitHub + webhook triggers with delivery history, project Events page: subscriptions, schedules, standing watches, channels, durable delivery outcomes)
5. Anything else uncommon among competitors: durable sleep/wake sessions, agent-to-agent durable messaging and missions, agent memory/policies (existing), app deployments, self-hostable AGPL control plane.

Constraints: copy must match what the screenshots show (no overselling); keep the dark-green glass +
Chillax + mascot brand; marketing-site changes stay on narrow CI; UI evidence (desktop + mobile
screenshots of every changed www surface) posted on the PR.

## Screenshot pipeline

- Real `apps/web` build served by `vite preview` on `http://localhost:4173` (`VITE_API_URL=http://localhost:4173`).
- Playwright specs in `apps/web/tests/playwright/marketing-shots-*.spec.ts` mock `/api/**` with rich fixture data, then write PNGs to `apps/www/public/images/features/` when `MARKETING_SHOTS=1` (tmp dir otherwise), following `docs-screenshots.spec.ts`.
- WebP siblings generated with `sharp` (Astro dependency) via `apps/www/scripts/optimize-feature-images.ts`.
- Evidence screenshots of the www pages themselves go to `tasks/evidence/2026-09-14-marketing-site-refresh/`.

## Screenshot contract (file names in `apps/www/public/images/features/`)

| Feature | File | Surface |
| --- | --- | --- |
| Multiplayer | `sam-collab-members-access.png` | Project Settings → Access: members, roles, pending request, invite link |
| Multiplayer | `sam-collab-all-sessions.png` | Project chat session list, all-sessions filter, several members |
| Multiplayer | `sam-collab-credential-attribution.png` | Credential Attribution panel |
| Comments | `sam-comments-inbox.png` | Project → Comments page grouped by waiting-on-you |
| Comments | `sam-comments-chat-thread.png` | Chat session with comments rail / thread on a message |
| Comments | `sam-comments-library-file.png` | Library file with comment panel |
| Compute | `sam-compute-pool-editor.png` | Infrastructure compute pool: multi-provider offerings, strategy, exhaustion |
| Compute | `sam-compute-placement-decision.png` | Session infrastructure panel / placement explanation |
| Compute | `sam-usage-tokens.png` | Token usage reporting surface |
| Compute | `sam-usage-compute.png` | Compute usage / node cost reporting surface |
| Events | `sam-triggers-sources.png` | Triggers page with cron, GitHub, webhook triggers |
| Events | `sam-webhook-deliveries.png` | Webhook trigger detail: credential/ingest URL, delivery history |
| Events | `sam-events-subscriptions.png` | Project Events: subscriptions, schedules, standing watches |
| Events | `sam-events-channels.png` | Event channel history |

(Adjust after the surface map confirms what exists.)

## Checklist

- [x] Surface map of the real app routes/endpoints/types for the four features (explore agent)
- [x] Playwright marketing screenshot specs written + run; PNG/WebP committed (4 specs, 30 new images, commit 03d1f50d7)
- [x] `features/` data gains new sections; homepage showcase, hero, comparison, roadmap, how-it-works updated
- [x] `/features/` index page; header nav updated
- [x] Enterprise cost-control page reconciled with real reporting surfaces (BYOC quota exemption verified in apps/api/src/services/compute-quotas.ts)
- [x] `pnpm --filter @simple-agent-manager/www lint/typecheck/build/check:links/test:browser` green (188 passed; new marketing-pages spec re-run green after review fixes)
- [x] Desktop + mobile Playwright screenshots of every changed www page reviewed and committed under `tasks/evidence/2026-09-14-marketing-site-refresh/`
- [x] Draft PR #2082 opened with preflight block, per-surface screenshot evidence, and a comment with images

## Notes

- Knowledge searched: BrandAssets (mascot-forward, #16a34a, Chillax, "SAM / simple agent manager" lockup), DeploymentTopology (www deploys from main only), ProductVision (usage reporting direction).

## Approved screenshots (what is actually visible — use for caption reconciliation)

Events (spec `marketing-shots-events.spec.ts`, all approved 2026-09-14):
- `sam-triggers-sources` — Triggers page (1440x1180): Nightly dependency audit (Active, Weekdays 4:00 AM UTC, Next in 11h, personal-credential attribution banner "runs on Priya's personal OpenAI key"), Weekly PCI evidence bundle (Paused, Mondays 7:00 AM), Triage new issues (GitHub issues), Review PRs labelled needs-review (GitHub pull request), Datadog critical alert → investigate (webhook, token ••••7k2q), Stripe deploy failed (webhook). No agent-profile names on cards.
- `sam-webhook-deliveries` — trigger detail from "Webhook credential" (token ends ••••7k2q, Rotate token, never-retrievable notice), Preview payload box + Preview button, Delivery history: Accepted (exec-datadog-9), Filtered, Accepted, Duplicate, Still Running, Concurrent Limit, Accepted, Rate Limited (429) with HTTP status and bytes.
- `sam-webhook-delivery-history` — element crop of the full 10-row delivery history incl. Configuration Error (503, missing_agent_profile).
- `sam-webhook-credential` — "Save your webhook credential" dialog: endpoint https://api.northwindlabs.dev/api/webhooks/ingest, sam_wh_ token, curl example with Idempotency-Key, one-time notice.
- `sam-events-subscriptions` — Events → Subscriptions: "Watch PR #482 (ledger migration) for review activity" (owner agent session, github/pull_request, requested "existing session prompt" → resolved "queued for prompt delivery", Inspect delivery / Cancel), "Resume signature rotation when Stripe redelivers" (webhook/webhook.accepted, runtime steer). Shows "Last match", not counts.
- `sam-events-schedules` — pending "Message session" at Sep 14 6:00 PM (Elena, "Re-run the payment-retry suite once CI settles", execution unavailable, Reconcile receipt, Reschedule/Cancel) and admitted "Start a new session" 4:05 AM (Priya, nightly dependency audit follow-up, execution completed, Open resulting session).
- `sam-events-watches` — "Flaky test triage" (ci/check_suite.failed → start a new session, active, 7/20 executions, 1 concurrent, 30 min cooldown, Edit/Pause/Revoke) and "Security-labelled issue watch" (github/issues.labeled/security, paused, 3/10, 60 min cooldown).
- `sam-events-channels` — #release-train (58 publications), #incidents (21), #ledger-migration (34); #release-train history #58 "v2026.37.0 promoted to canary", #57 "Staging soak started", #56 "Rollback: v2026.36.2", each attributed to an agent session in the body.
- `sam-activity-stream` — 12-row feed: webhook accepted, prompt delivery accepted, github pull request opened, Task "Nightly dependency audit follow-up" completed, schedule admitted, Chat session started, trigger execution started, review requested, Chat session stopped (24 messages), comment created, Workspace "ws-payment-retry" created.

Collaboration & comments (spec `marketing-shots-collab.spec.ts`, all approved 2026-09-14):
- `sam-collab-members-access` — Members panel: Priya (owner), Marcus/Elena/Tomás/Aisha (admin, Transfer ownership / Remove member), Pending Requests 2: Jordan Lee (GitHub verified badge), Sam Whitfield (no repo access), Invite Link (Expires Sep 24, Used 6 times, https://app.northwindlabs.dev/projects/invite/…, Copy / New Link / Revoke).
- `sam-collab-invite-request` — "Request access" card: Payments API · northwind-labs/payments-api · Request Access button.
- `sam-collab-all-sessions` — chat with My sessions / All sessions toggle (All active); 8 sessions with owner chips (You, Marcus Chen, Elena Rossi, Tomás Alvarez, Aisha Okafor; one automation session without owner); open session shows prompt, assistant reply, Bash + Edit tool rows, final summary, "2 need you" comment chip.
- `sam-collab-credential-attribution` — Credential Attribution modal: 2 needs review / 2 personal keys / 2 project covered; Triggers: Nightly dependency audit on Marcus's personal Claude Code key (Fix); Running tasks: Backfill merchant timezone column on Elena's personal Codex key (Fix); Deployments: Staging deployment on project credential Northwind Shared Hetzner; Nodes: fsn1 workspace node on the same project credential.
- `sam-comments-inbox` — Comments page: All 9 · Needs you 3 · With agent 2 · Open 2 · Resolved 2; threads quote sentences from chat sessions and library files (refund-webhook-runbook.md, Migrate ledger…), authors Marcus/Aisha/Elena/You.
- `sam-comments-chat-thread` — desktop Comments rail (2 threads): thread on a quoted assistant sentence with Elena's comment, Priya's reply marked "Sent to agent", a reply from "Claude Code — Opus 5", Reply/Resolve; second open thread by Marcus with Reply / Send to agent / Resolve.
- `sam-comments-library-file` — ledger-migration-plan.md preview (Rendered/Source/Download/Comments) with an open thread quoting the doc (Tomás + Priya reply, Reply/Resolve) and a resolved thread (Marcus, "Show resolved thread (2)").

Platform (spec `marketing-shots-platform.spec.ts`, all approved 2026-09-14):
- `sam-hero-live-session` (1440x1050) — session "Add idempotency keys to refund webhook": header chips Active · Full · Your session · "2 need you"; Priya's prompt ("…Also backfill the last 30 days of refund events."), assistant reply ("I'll add idempotency protection in four steps…"), 1-comment indicator, PLAN panel (2 done struck through, "Update signature + replay tests" running, "Run the full webhook test suite" pending), tool cards Read payments/webhooks/refund_handler.py, Edit refund_handler.py:142, running Bash `pytest tests/webhooks/test_refund_idempotency.py -q`; dock with Plan + timer + stop button; sidebar with 8 sessions (Task/Chat kinds, subtask icons); right tool rail.
- `sam-agents-orchestration` — Task Hierarchy modal: "Ship refund idempotency" (RUNNING, CURRENT) with children "Add idempotency_key migration + backfill (PR #482 opened)" COMPLETED, "Get sign-off before rotating prod idempotency keys" QUEUED · BLOCKED, "Update webhook signature verification tests" RUNNING.
- `sam-session-sleeping` — "Stripe webhook signature rotation": Sleeping chip, 6-message transcript (prompt, plan, Bash `stripe webhook_endpoints update …`, Edit deploy/staging.env:8, follow-up question, final reply "Going to sleep — send a message if you need anything else."), grey Archive button, composer "Send a message to wake the agent...".
- `sam-session-waking` — same session with top banner "Recreating your workspace..." and composer "Waking the agent — your message will be delivered...".
- `sam-app-deployments` — Deployments: New Environment form; preview-pr-482 (starting · Unknown · v1 created · No routes · payments-deploy-preview · Stale), production (active · Serving · v13 applied · 1 route · payments-deploy-prod · Healthy), staging (active · Serving · v14 applied · payments-deploy-staging · Healthy).
- `sam-app-deployment-detail` — staging: Release v14 applied, submitted by Claude Code — Opus 5 / task-ship-refund-idempotency; tabs Overview/Domains/Volumes/Logs/Configuration/Policy/Node & Metrics; Serving; health grid App healthy · Node healthy · Provider managed · Routes issued · Disk normal · Config none · Root disk 27.4%; public route staging.payments.northwindlabs.dev; Stop / Destroy Env.

## Review outcome (2026-09-14)

Local `ui-ux-specialist` review: HIGH — "platform incidents" removed as a customer trigger source (SAM-internal sweep only); comparison table reflows to stacked cards below 768px. MEDIUM — unused `screenshots[1..]` data removed (type narrowed to one hero image), proof strip shared via `src/data/proof-strip.ts`, cost-control table wrapper focusable. LOW — focus-visible outline added; roadmap density, comments docs link, dense screenshots at 375px left as-is.

Images generated but not used on the site were deleted with their spec captures: activity stream, deployments list, schedules, delivery-history crop.

## SonarCloud (2026-09-14)

First run failed the quality gate on 10.6% duplicated new code. Cause: the ten feature-section TypeScript files were shape-identical object literals (Sonar anonymizes literals for CPD), plus three repeated fixture blocks in the screenshot specs and the overflow/axe check copied between two www specs. Fix: feature content moved to `apps/www/src/data/features/<slug>.json` with a validating barrel in `index.ts`; spec fixtures built through small helpers (`agentProfile`, `subscription`, shared `HERO_SESSION`); shared `expectNoOverflowOrSeriousAxeViolations` in `apps/www/tests/playwright/fixtures.ts`.

## Round 2 (Raphaël feedback, 2026-09-14)

- Hero: keep "The open-source platform for multi-agent workflows"; new subtitle text supplied by Raphaël.
- Every UI screenshot must also exist in light mode and be shown when the site is in light mode. Implemented as `<name>-light.png` siblings (specs run with `MARKETING_THEME=light`; `marketingShot` adds the suffix; `OPAQUE_BACKDROP_COLOR` keeps modal backdrops theme-correct) and `OptimizedFeatureImage.astro` renders both `<picture>`s with CSS switching on `html[data-theme]`. The 12 older screenshots (dashboard, notifications, ideas, library, document viewer, settings, agent-context tabs, new chat, tool stream) were regenerated from specs in both themes (`marketing-shots-workspace.spec.ts`, `marketing-shots-context.spec.ts`); legacy files and the name map in `OptimizedFeatureImage.astro` are gone. Every PNG under `public/images/features` has a `-light` sibling and is referenced by a page.

Round-2 SonarCloud: duplication landed at 3.04% (gate ≤ 3%) because the context spec copied the platform spec's agent-profile fixtures; `agentProfile` + `AGENT_PROFILES` now live in `marketing-shots-helpers.ts` (commit ddffec06e).
