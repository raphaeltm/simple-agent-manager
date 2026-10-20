# Document the week's user-facing changes (2026-10-13 → 2026-10-20)

Branch: `sam/docs-update-m27gbe`
Task: `01M5BMKMMM0YFP22ZCV3M27GBE`
PR: _not yet opened_

## Goal

Find the past week's changes that alter what a user, admin, self-hoster or agent can do (or how they
perceive SAM), then reflect them in the public docs site under `apps/www`, written around what a
person is trying to accomplish, with Playwright screenshots of the real components (mock data) where
a picture helps. The previous pass (#2324, archived as
`tasks/archive/2026-10-13-docs-update-weekly-ux-changes.md`) covered PRs up to #2321 and reconciled
#2327, #2331, #2332 and #2362; this pass covers everything merged after it.

## Candidate changes (to verify in code)

| PR    | Change (claim)                                                                         | Docs state (initial) |
| ----- | -------------------------------------------------------------------------------------- | -------------------- |
| #2381 | Shared chat sessions (timed access), cross-member comments, @mentions, Send to agent   | PR updated docs      |
| #2363 | SAM no longer commits/pushes/opens PRs at turn end or task completion (agent-directed) | stale leftovers      |
| #2358 | Git access retries/authorization, devcontainer credential helper                       | ?                    |
| #2304 | Dynamic admin settings (23 typed controls, audited, mobile editor)                     | admin-settings.md    |
| #2371 | MCP rate counters and boot logs move to Durable Objects (activation record)            | ?                    |
| #2305 | Empty managed VMs reaped through warm retention (cron backstop)                        | PR updated docs      |
| #2337 | Archived chats keep a **Fork** composer with automatic context                         | ?                    |
| #2359 | Attachments: paste/drop, staged while sleeping, delivered after wake                   | PR updated docs      |
| #2360 | Compute pool settings: plain-language summary and region picker                        | PR updated docs      |
| #2350 | Old permission receipts stay in history, not the live footer                           | ?                    |
| #2318 | Tasks park until provider usage limits reset                                           | troubleshooting      |
| #2379 | Model catalog refresh                                                                  | ?                    |
| #2378 | MCP `associate_pull_request` / `list_pull_request_associations`                        | mcp-servers.md       |
| #2326 | MCP `list_channel_subscribers`                                                         | agents.md, api.md    |
| #2332 | Secret variables are placeholders; `exec_with_secrets`                                 | secret-execution.md  |
| #2374 | Agent CI-wait guidance (exact event names, full SHAs)                                  | ?                    |
| #2335 | Durable GitHub trigger delivery recovery                                               | ?                    |
| #2377 | VM conversation wake no longer fails on a deleted predecessor's binding                | ?                    |

## Research findings (verified in code by five local research agents)

Full reports (local only): `.tmp/docs-update/research-*.md`. Headlines:

- **#2363**: nothing commits, pushes or opens a PR/MR any more, on either runtime. Task agents are only told
  to push the output branch before `complete_task`; nothing tells any agent to open a PR. ~20 stale doc
  statements (overview, quickstart, index, concepts, agents, chat-features, troubleshooting, idea-execution,
  notifications `pr_created`, cli, project-files, creating-workspaces, self-hosting GitLab scope, changelog).
- **#2381**: docs mostly right, but teammates with shared access CAN fork/retry (docs say not), no
  notification on expiry (concepts says yes), share steps wrong ("Add a teammate" is a heading), teammate and
  non-owner views undocumented, rail screenshot predates **Share**.
- **#2337**: archived and expired chats now show a **Fork** composer; the **Fork conversation** button is
  gone; Expired troubleshooting text and `chat-expired*.png` show removed UI;
  `docs-screenshots-chat-states.spec.ts` fails against current code.
- **#2359**: chat-features attachment sections contradict (old `.private` + `FILE_UPLOAD_*` limits);
  real limits 50 MB / 200 MB / 20 files, 4,000-character paste rule.
- **#2318**: provider usage limits park and resume (own credentials); agents.md:128-133,
  chat-features.md:527, troubleshooting:446 still say the task fails.
- **#2304**: admin-settings guide is internals-first and missing from the sidebar; trials KV switch no
  longer overrides a saved value (self-hosting.mdx:445, security.md:296); a saved value beats
  `CONNECTOR_ENABLED`; api.md runtime-controls stale.
- **Self-hosters**: releases up to v2026.10.16 now fail to deploy at **Configure R2 CORS** (Cloudflare
  rejects the old field names; fixed in v2026.10.17 by #2370). After v2026.10.18 (#2371, DO migration v22)
  the pipeline refuses to redeploy an older release.
- **#2332**: secret-execution guide accurate but implementer-oriented (no UI path, limits, troubleshooting).
- **#2374**: agents.md:405 uses bare `check_run` names and "the head SHA" (now `check_run.completed`, full SHA).
- **#2378**: PR-association tools documented only in mcp-servers.md, in implementation language.
- **#2335**: GitHub trigger deliveries retried for ~2 h; Redeliver doesn't double-run; 9
  `GITHUB_TRIGGER_RECOVERY_*` vars undocumented.
- **#2360/#2305/#2379/#2377/#2358/#2350**: small fixes and changelog entries; Git access troubleshooting entry.
- Policy: `reference/roadmap.md:73` mentions missions (public content must not).

Product bugs to file as SAM ideas (not docs work): GitLab agents told "SAM will create a GitLab merge
request" (`instruction-tools.ts:346`); "Output on branch" notification text; onboarding/profile-card/runtime
hints still implying automatic delivery; admin settings errors shown only as "Save could not be confirmed",
PATCH cap of 23 changes vs 26 settings, Settings missing from the command palette; possible Send-to-agent-on-a-
reply mislabel.

## Implementation checklist

- [x] Research: verify each change in code (five local research agents) and audit the docs
- [x] Fix stale automatic-publication statements left after #2363 (also the integration pages in
      `apps/www/src/data/integrations.ts` that promised automatic PRs)
- [x] Fix other now-wrong statements (fork/expired, provider limits, attachments, shared-access fork,
      expiry notification, trials KV, CI wait names, roadmap missions)
- [x] Shared sessions/comments: teammate and non-owner views, Send to agent, finding shared chats
- [x] Admin settings guide rewrite + sidebar; secret execution guide rewrite (user-first)
- [x] Smaller gaps: compute pools, PR associations, trigger recovery, Git access, configuration vars
- [x] `recent-product-changes.md`: new 13 – 20 October cycle (incl. self-hoster R2 CORS + rollback notes)
- [x] Playwright docs screenshots (real components, mock data), desktop and mobile, reviewed: share
      dialog, teammate view, comment + mention, rail with Share, archived/expired Fork composer, fork
      composer, admin settings, compute pool
- [x] File product bugs as SAM ideas; update stale "Comments feature" knowledge (shipped access is timed):
      new ideas `01M5BRDZF2314EAE7S8HBD37NX` (publication leftovers, GitLab MR instruction),
      `01M5BRE4WHCKVF0DTAHDVTJDTC` (admin settings UX), `01M5BREXSE42RBT0BQMK3Z72FG` (provider-limit
      "Blocked" label); appended to `01M4SW64BE2CXX18F5TN2TMWR2` and `01M59MYE4GY91BWTE8TZF1ZB5D`
- [ ] Local sub-agent review loop until no actionable feedback
- [ ] www build, link check, browser tests; PR green and merged; task completed in SAM

## Local environment notes

- `pnpm install --frozen-lockfile`; `pnpm turbo run build --filter='@simple-agent-manager/web^...'`;
  `npx playwright install chromium` (from `apps/web`).
- Baseline before edits: www build OK (249 pages), `check:links` 0 broken across 37 doc pages.
- Screenshot specs follow `apps/web/tests/playwright/docs-screenshots-*.spec.ts` with `docs-shot.ts`
  (`DOCS_SHOTS=1` writes to `apps/www/public/images/docs/`). Mock sources to reuse:
  `shared-session-collaboration-audit.spec.ts`, `shared-session-viewer-audit.spec.ts`,
  `admin-settings-audit.spec.ts`, `default-capacity-pools-scopes-audit.spec.ts`,
  `fork-retry-new-chat-audit.spec.ts`, `message-comments-audit.spec.ts`.
- Release tags: v2026.10.13 = #2326; v2026.10.14 = #2334 (has #2327, #2332); v2026.10.15 = #2349
  (has #2331, #2335); v2026.10.16 = #2356 (has #2350, #2359, #2360, #2362); v2026.10.17 = #2304
  (has #2337, #2358, #2305, #2363, #2370); v2026.10.18 = #2374 (has #2371); v2026.10.19 = #2379
  (has #2377, #2378). #2381 is in production (Deploy Production 39356347146, 01:58 UTC 20 Oct) but
  not yet in a release.
- `admin-settings.md` is not in the sidebar (`apps/www/astro.config.ts`).
- `deploy-www.yml` publishes the docs on any `apps/www/**` push to main.
- Screenshots: new specs `docs-screenshots-collaboration.spec.ts` (share confirm, teammate view, mention;
  fixed clock/UTC, idle state, `agentSessionId: null` so connection recovery can't flip Idle→Active,
  taller 375-wide phone frames) and `docs-screenshots-admin-settings.spec.ts`; `docs-screenshots-chat-states`
  expired scenes updated for the archived Fork box (it failed since #2337); `docs-screenshots-sessions` rail
  now includes Share. Only changed scenes were written with `DOCS_SHOTS=1` (`-g` filters), then
  palette-compressed with sharp. Compute pools reuses `/images/features/sam-compute-pool-editor.*`
  (regenerated by #2360). Phone captures need `sudo npx playwright install-deps chromium`.
- `pnpm turbo` rewrites root `AGENTS.md` with a Turborepo agent block; restore it, don't commit it.
- Same-page `#anchor` links aren't covered by `check:links`; checked separately against `dist`.

## Review log

### Round 1 (two local reviewers: user-journey critique + code fact-check)

- **Journey reviewer** (3 HIGH, 4 MEDIUM, 7 LOW). Fixed: OpenCode integration step and GitHub
  permissions FAQ still implied SAM publishes; **Build and open PRs** doesn't add a PR instruction
  (quickstart, chat-features); no rollback path (self-hosting caution + migration-tag troubleshooting +
  changelog); "Finished without a pull request?" recovery (idea-execution + troubleshooting symptom);
  Shared Session notification is under **Updates** and owner-only agent notifications
  (collaboration); real steps for a **Blocked** provider-limit task; GitLab sign-in subsection; changelog
  wording; CI-wait subscription call; superadmin wording, self-host version, Share icon, project
  **Comments** inbox; admin settings "Not configured" and pre-v2026.10.17 sources; Fork box **Agent**
  default; compute pool roles; orchestrator var descriptions.
  Pushed back: `sam chat cancel` only interrupts the in-flight prompt (`routes/chat-cancel.ts`), so it is
  not offered as a way to end a Blocked task; GitLab "agents open merge requests" claim removed instead of
  expanded (nothing opens GitLab MRs; agents are told SAM will, filed in idea `01M5BRDZF2314EAE7S8HBD37NX`).
- **Fact-check reviewer** (0 CRITICAL/HIGH, 5 MEDIUM, 10 LOW, rebase needed). Fixed: #2371 storage
  activation is manual (changelog); a Task's agent pushes without being asked (instant-sessions,
  integrations, quickstart); #2377 wake-budget bullet narrowed; collaboration limits release
  (configuration); emergency KV switch shows Disabled · kv (admin-settings); trigger retries re-check the
  trigger; Comments panel shows resolved threads collapsed; three notification tabs; provider-limit
  backoff 5/10/20 min; full git-token error text; trigger form fills one action; secret placeholders
  wording; PR takeover wording; security.md permission list; mission wording.
- **Rebase onto main** (#2382, #2384, #2385): conflicts in concepts, overview and troubleshooting
  resolved in favour of main's sleep-failure notices; #2382 (idle runtime terminated after repeated
  snapshot failures, unpushed files may be lost) added to idea-execution and the changelog.
