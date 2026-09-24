# Weekly queue reconciliation — 2026-09-23

**SAM task:** `01M383N1GAKM3NAH5QV9690KZX`
**Branch:** `sam/weekly-queue-memory-reconciliation-690kzx`

## Problem

`tasks/active/` and `tasks/backlog/` had drifted badly from shipped reality. At the start of this
audit `tasks/active/` held **182** files (the brief estimated ~75) and `tasks/backlog/` held
**310** (the brief estimated ~260). Every one of the 182 active files already existed on
`origin/main`, which is the tell: the `/do` workflow moves a task file to `tasks/active/` in
Phase 2 and is supposed to move it to `tasks/archive/` in Phase 4, but agents routinely merged
the PR with the file still sitting in `active/`. Some had been there since February.

A queue that lists 182 "active" items when 1 is actually open is worse than no queue: nobody can
tell what is being worked on, and the next agent re-derives priorities from scratch.

## Method

Evidence-first, because filename and checkbox state are both unreliable:

1. Parsed every task file for PR references, branch references, and checkbox counts.
2. Pulled **2,004** PR records from GitHub (the 1,000-PR list cap needed a second ascending
   page plus per-number fetches to cover the gap) and built the set of **1,476** PR numbers
   squash-merged into `main` from `git log`.
3. Resolved, for each task file, the exact commit that last touched it — the commit that
   _landed_ the file on `main`.
4. Bucketed by checklist completion, then **verified the ambiguous cases against code in `main`**,
   not against PR state.

Step 4 was not optional. Two findings only came out of it:

- **A merged landing PR does not prove the work shipped.** A task file can reach `main` via an
  unrelated PR. `2026-09-19-port-app-deployment-fixes-and-dedupe-pending-release.md` is 37/37
  checked; its first check looked like a miss because `pendingReleaseSeq` is absent from
  `apps/api/src/durable-objects/node-lifecycle.ts`. It is in
  `apps/api/src/routes/node-lifecycle.ts:771`, shipped by PR #2102. Checking one wrong path
  nearly left a shipped task open.
- **`wrangler.toml` does not prove the deployed value** (`.claude/rules/70`).
  `2026-09-14-enable-tool-payload-cleanup-and-raise-archive-throughput.md` had ten unchecked
  items, all of them "set this GitHub Environment variable", and `wrangler.toml` showed the
  manifest key, SHA and caps as `""`. Reading the real `production` Environment showed every one
  of those values applied, down to the exact
  `MANIFEST_SHA256=c90fca2c30186b628bcf5c18a0744657bf7347901754789bfafb4f79504e7bd3` and
  `MAX_TOTAL_ROWS=15539` the checklist specified. The task had shipped.

## Outcome

| Directory        | Before |    After |
| ---------------- | -----: | -------: |
| `tasks/active/`  |    182 |    **1** |
| `tasks/backlog/` |    310 |  **293** |
| `tasks/archive/` |    898 | **1079** |

- **180 archived** from `active/` — work verified shipped.
- **1 moved to `backlog/`** — stale but still plausibly wanted.
- **1 left in `active/`** — `2026-09-03-projectdata-production-capacity-emergency.md`, the only
  file whose headline acceptance criterion is measurably unmet.
- **19 backlog entries removed**, each with verified shipped/duplicate/superseded evidence.
- **1 backlog entry added** for a rule violation this audit uncovered.
- **2 backlog entries narrowed/consolidated** rather than deleted.

Nothing was silently dropped, and the arithmetic closes exactly:

```
before   182 active + 310 backlog +  898 archive = 1390
after      1 active + 293 backlog + 1079 archive = 1373
check    1390 - 19 deleted + 1 ledger + 1 new backlog entry = 1373   ✓
```

(Counts are recursive. `tasks/archive/` contains one pre-existing nested file at
`tasks/archive/completed/`, unrelated to this PR; counting the "before" recursively and the "after"
with `-maxdepth 1` is what produced the off-by-one the validators caught.)

## Review round — what the validators changed

Two local reviewers ran against the first cut of this reconciliation and both found real problems.
Recording them here because the corrections are more instructive than the original pass.

**`doc-sync-validator` — HIGH.** Moving 181 files out of `tasks/active/` broke **34 citations in 26
files** that referenced those paths. These were not just rule prose: they included
`apps/api/wrangler.toml:244`, `packages/eslint-plugin-sam/rules.manifest.json` (4 occurrences),
`scripts/quality/astro-check-baseline.json`, two test files and a Playwright spec. Several rules exist
as duplicated path-scoped copies (49, 50, 52, 57, 61, 63, 69, 71, 75 under `apps/api/`,
`packages/providers/`, `packages/shared/`, `packages/vm-agent/`), so they had to be fixed in pairs or
they would drift again. All 34 rewritten to `tasks/archive/…`; a repo-wide sweep now reports zero
broken task-file references outside `tasks/`, except three deliberate `e.g.` placeholders in rules 09
and 14 and two pre-existing dangling refs this PR did not create
(`packages/vm-agent/internal/bootstrap/bootstrap.go:2461`, and a dated blog post at
`apps/www/src/content/blog/sams-journal-ready-only-rings-once.md:95` — historical narrative, left alone).

`apps/api/src/durable-objects/notification.ts:8` pointed at a backlog file this audit deleted, so it
was repointed at `tasks/archive/2026-03-16-notification-system-phase2.md`, which exists.

**`task-completion-validator` — HIGH.** `2026-02-19-task-ui-ux-polish.md` was demoted to `backlog/`
as "narrow, genuine, not urgent" open work. That was wrong, and the validator proved it item by item:
the `TaskDelegateDialog` work shipped (`TaskDelegateDialog.tsx:2,41,65`), and the `TaskDetailPanel`
item targets a component built in `f97c1edcc` and deleted one commit later in `7f424319a`. Three of
four items shipped, the fourth is moot. The file is now **archived with all four boxes corrected**
and an explanation of why item 3 is ticked as resolved rather than built.

The lesson: a low checkbox ratio is not evidence of open work, and this audit's own bulk heuristic
("low ratio ⇒ demote") reproduced the exact error it exists to correct. Every demotion needs the same
per-item verification an archive decision gets.

**`task-completion-validator` — MEDIUM, and a genuine escape.**
`2026-09-18-polish-project-events-page-ui.md` was archived as fully shipped. Its headline work is
live, but one checklist item was not done: `PROJECT_SCHEDULES_POLL_MS` was never added and
`SchedulesPanel.tsx:324` still polls on a bare `refetchInterval: 30_000`. That task's own research
section had predicted this would violate `.claude/rules/60` and Principle XI. Filed as
`tasks/backlog/2026-09-23-schedules-panel-hardcoded-poll-interval.md`, and the archived file's footer
now says so rather than claiming a clean ship.

**`task-completion-validator` — MEDIUM, on "fix stale checkboxes".** The first cut centralised status
into this ledger and left all 181 moved files byte-identical (`R100` renames), which is not what the
task asked for. Mass-ticking 179 files without per-item evidence would have been fabrication, so each
archived file now carries a one-line provenance footer instead: how it landed on `main`, its checklist
ratio, and an explicit statement that the remaining boxes are stale and were left rather than ticked
unverified. Anyone opening an archived file directly now sees the true status without needing this
ledger.

**Both — LOW.** The archive count in the table above said 1077; the correct recursive count is 1079.
Fixed. The full-total reconciliation was never wrong.

## The one task still open

`2026-09-03-projectdata-production-capacity-emergency.md`. Its acceptance criterion is production
`sql.databaseSize` at or below **9,000,000,000** bytes. The production root ProjectData DO measured
**10,103,668,736** bytes at 2026-09-23 21:48Z, status `degraded` — above the configured 10^10
limit, not below the 9 GB target. The code and the approved plan config both shipped (PR #2014,
and the full `PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_*` plan is armed in the `production`
Environment); the _outcome_ has not been reached. A reconciliation block was appended to that file
recording what is proven done, what remains, and the live threads (Slice A PR #2133 merged, Slice B
PR #2136 open, Slice C queued).

## Moved to `backlog/` instead of archived

| File                                         | Why                                                                                                                                                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2026-02-20-acp-session-error-observability` | 6/22. The per-session event timeline API (`GET /workspaces/:id/agent-sessions/:sessionId/events`) does not exist in `main`. Real, unstarted, 7 months stale — it is a backlog item, not active work. |
| ~~`2026-02-19-task-ui-ux-polish`~~           | **Reversed during review — archived, not demoted.** Three of its four items shipped and the fourth targets a component deleted in `7f424319a`. See the review-round section above.                   |

## Backlog entries removed

Verified shipped:

| File                                                    | Evidence in `main`                                                                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2026-02-23-cli-tool`                                   | `packages/cli/cmd/sam`; superseded by the archived `2026-05-19-sam-cli-mvp`                                                                                    |
| `2026-03-09-task-resource-requirements`                 | `resource_requirements_json` + `resource_requirements_source` on tasks and workspaces in `schema.ts`                                                           |
| `2026-05-01-persist-task-requested-vm-size`             | `requested_vm_size` + `requested_vm_size_source` in `schema.ts:939` — including the provenance the task asked for                                              |
| `2026-04-01-add-agent-profile-support-to-dispatch-task` | `agentProfileId` handled throughout `apps/api/src/routes/mcp/dispatch-tool.ts`                                                                                 |
| `2026-06-06-productionize-project-onboarding-wizard`    | `/projects/new` renders `ProjectOnboardingWizard` (`App.tsx:288`), a real multi-step wizard with `ONBOARDING_STEPS`, not the flat form                         |
| `2026-05-12-hetzner-capacity-retry`                     | `capacityRetryInitialDelayMs` / `MaxDelayMs` / `MaxAttempts` / `BudgetMs` in `packages/providers/src/hetzner.ts`                                               |
| `2026-04-25-upgrade-wrangler-v4-unblock-artifacts`      | wrangler pinned at `4.125.0` in `pnpm-workspace.yaml`                                                                                                          |
| `2026-03-14-notification-system`                        | `durable-objects/notification.ts`, `notification-push.ts`, `NOTIFICATION` binding, VAPID, `NotificationCenter.tsx`                                             |
| `2026-03-16-notification-system-phase1`                 | byte-identical duplicate of the row above (`diff` reports no difference)                                                                                       |
| `2026-07-11-ci-does-not-run-do-worker-tests`            | `pnpm --filter @simple-agent-manager/api test:workers` runs at `.github/workflows/ci.yml:712`                                                                  |
| `2026-07-11-workers-pool-tests-not-run-in-ci`           | same issue, same evidence — third of three files for one problem                                                                                               |
| `2026-07-16-wire-test-workers-into-ci`                  | same issue, same evidence                                                                                                                                      |
| `2026-09-04-truthful-vm-workspace-deletion`             | proof-bearing deletion shipped (`services/workspace-deletion.ts`, NodeLifecycle durable deletion queue); the same filename already existed in `tasks/archive/` |
| `2026-06-07-harden-github-token-injection`              | shipped via `5dce7bce9` + `repositoryIds`/`repository_ids` scoping in `services/github-app.ts`; duplicate of the active task archived in this same PR          |
| `2026-06-11-caddy-acme-spike`                           | spike obsolete — production Caddy routing/TLS shipped via PR #1308, fixed by #1582; `packages/vm-agent/internal/deploy/caddy.go`                               |

Superseded or duplicated:

| File                                                | Superseded by                                                                                                                                                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2026-03-01-migrate-source-contract-tests`          | `2026-04-01-replace-source-contract-tests` (same problem, better-scoped); the live narrow slice is `2026-08-11-migrate-remaining-source-contract-ui-tests`                                                  |
| `2026-03-16-wire-node-idle-timeout-to-lifecycle-do` | `2026-09-09-node-idle-timeout-project-setting-has-no-consumer` — newest and best-scoped of three files for one unwired setting                                                                              |
| `2026-03-30-wire-node-idle-timeout`                 | same                                                                                                                                                                                                        |
| `2026-04-18-agent-key-card-a11y`                    | merged into `2026-04-18-agent-key-card-accessibility` — same component, same review cycle, different findings; the unique items (including the delete-scope correctness bug) were carried over, not dropped |

Narrowed rather than deleted:

| File                                    | Change                                                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `2026-02-16-additional-cloud-providers` | Removed the DigitalOcean, Vultr, UpCloud and GCP sections — all four shipped in `packages/providers/src/`. Linode/Akamai, AWS Lightsail and OVH remain open. |

## Deliberately kept

`2026-03-18-gcp-self-hosting-docs` looked shipped (self-hosting.mdx has a whole "GCP provisioning
credentials" section) but is not: the task asks for the **five APIs required on the OAuth client
project** (`cloudresourcemanager`, `iam`, `serviceusage`, `sts`, `iamcredentials`) and the docs
enable only `compute.googleapis.com`. Kept.

The ~35 "test coverage gaps" backlog files matched each other on phrasing but cover different
subsystems (log viewer, virtual scrolling, notifications, compute lifecycle, compose parser).
Not duplicates. Kept.

Three file-split tasks were checked and are all still open, and one has grown:
`apps/api/src/env.ts` is 1,429 lines, `apps/web/src/pages/ProjectLibrary.tsx` is 812, and
`apps/api/src/scheduled/project-data-archive-sharding.ts` is **4,182** lines — its backlog entry
(`2026-09-12`) was filed at 3,663 lines, so it gained ~520 lines while sitting in the queue. That
is 8.4x the 500-line ceiling in `.claude/rules/18`.

## Archived from `tasks/active/` (179)

Each row: the commit that landed the file on `main`, the checklist state at audit time, and that
commit's subject. Files in the 70–89% band were archived because their unchecked items are
trailing process steps ("open the PR", "merge", "monitor the production deploy") that the merged
landing commit itself proves were done.

| Task file                                                             | Landed via     | Checklist | Landing commit subject                                             |
| --------------------------------------------------------------------- | -------------- | --------: | ------------------------------------------------------------------ |
| `2026-02-17-devcontainer-remote-user-detection`                       | direct-to-main |       93% | `fix(vm-agent): resolve devcontainer runtime user consistently`    |
| `2026-02-23-node-size-selection`                                      | PR #180        |       91% | `feat: add node size selection across all creation flows (#180)`   |
| `2026-02-23-pty-session-shrinking`                                    | PR #177        |       89% | `fix(terminal): fix PTY session shrinking on tab switch (#177)`    |
| `2026-02-28-fix-new-chat-sidebar-auto-select-race`                    | PR #226        |       95% | `fix: broken New Chat button + mandatory post-mortems for bug fix` |
| `2026-03-01-environment-independent-deploy`                           | PR #230        |       93% | `refactor: environment-independent deployment pipeline with stagi` |
| `2026-03-03-openai-codex-oauth-token-support`                         | PR #253        |       39% | `Add OpenAI Codex OAuth token support with auth.json injection (#` |
| `2026-04-13-direct-vm-agent-acp-heartbeats`                           | PR #688        |       95% | `feat: add direct VM agent ACP heartbeats (#688)`                  |
| `2026-05-04-devcontainer-gitconfig-lock`                              | PR #893        |       94% | `fix: tolerate stale devcontainer gitconfig locks (#893)`          |
| `2026-05-06-project-chat-session-error-diagnostics`                   | PR #917        |       89% | `fix: add chat session load error diagnostics (#917)`              |
| `2026-05-08-provider-adapter-hardening`                               | PR #932        |       95% | `fix: harden provider adapters (#932)`                             |
| `2026-05-09-refactor-vm-agent-start-agent`                            | PR #941        |       71% | `refactor: split VM agent session host (#941)`                     |
| `2026-05-19-gemini-cli-agent-integration`                             | direct-to-main |       86% | `feat: wire Gemini CLI ACP support`                                |
| `2026-05-19-pre-persist-orchestration-prompts`                        | PR #1074       |       86% | `fix: pre-persist orchestration prompts (#1074)`                   |
| `2026-05-19-sam-cli-mvp`                                              | PR #1058       |       92% | `Add SAM CLI MVP (#1058)`                                          |
| `2026-05-21-amp-sam-mcp-bridge`                                       | PR #1094       |       88% | `feat: bridge Amp sessions to SAM MCP via stdio mcp-remote (#1094` |
| `2026-05-24-fix-stopped-node-cleanup`                                 | PR #1109       |       86% | `fix(api): clean up stopped node handoffs (#1109)`                 |
| `2026-05-28-cli-artifact-distribution`                                | PR #1138       |       90% | `feat: distribute CLI artifacts from deployment R2 (#1138)`        |
| `2026-05-28-workspace-forward-staging-verification`                   | PR #1135       |       85% | `Fix workspace port forwarding staging failures (#1135)`           |
| `2026-05-29-cli-auth-pats-device-flow`                                | PR #1147       |       79% | `feat: CLI authentication with PATs and OAuth Device Flow (#1147)` |
| `2026-06-01-fix-task-title-generation-reasoning-output`               | direct-to-main |       80% | `Fix task title generation reasoning output`                       |
| `2026-06-06-light-mode-foundation-layer`                              | PR #1239       |       95% | `feat(web): light mode (consolidated) (#1239)`                     |
| `2026-06-06-light-mode-slice-c-workspace-chrome`                      | PR #1239       |       89% | `feat(web): light mode (consolidated) (#1239)`                     |
| `2026-06-08-harden-github-token-injection`                            | direct-to-main |       47% | `Harden GitHub token injection authorization boundary`             |
| `2026-06-12-productionize-caddy-routing-tls`                          | PR #1308       |       92% | `Productionize Caddy routing + TLS for app-deployment nodes (#130` |
| `2026-06-15-codex-acp-midprompt-disconnect`                           | PR #1568       |       57% | `fix: recover ACP mid-prompt peer disconnects via captured LoadSe` |
| `2026-06-15-codex-loadsession-recovery-reporting-guard`               | direct-to-main |       80% | `fix(vm-agent): report codex LoadSession recovery as recovered`    |
| `2026-06-15-unblock-prod-deployments`                                 | PR #1331       |       86% | `ci: avoid live MCR pulls in devcontainer tests (#1331)`           |
| `2026-06-19-deployment-node-bin-packing`                              | PR #1356       |       71% | `Add app deployment control surface and policy gate (#1356)`       |
| `2026-06-20-opencode-go-provider`                                     | PR #1374       |       n/a | `Add OpenCode Go provider for GLM 5.2 (#1374)`                     |
| `2026-06-22-deployment-compose-interpolation-config`                  | PR #1381       |       95% | `Deployments UI subpages + unified Variables/Secrets config (#138` |
| `2026-06-23-two-week-agent-feedback-audit`                            | PR #1426       |       93% | `docs: consolidate agent-instruction optimizations from #1264, #1` |
| `2026-06-24-deployment-custom-domain-ui`                              | PR #1398       |       90% | `Add deployment custom domains UI (#1398)`                         |
| `2026-06-25-deployment-artifact-deadlines`                            | direct-to-main |       92% | `Fix deployment artifact deadline handling`                        |
| `2026-07-01-claude-code-1m-model-selectors`                           | PR #1464       |       83% | `Add Claude Code 1M model selectors (#1464)`                       |
| `2026-07-01-origin-ca-fail-closed`                                    | PR #1462       |       93% | `fix: fail closed on Origin CA bootstrap errors (#1462)`           |
| `2026-07-02-build-publish-volumes-ui`                                 | PR #1478       |       91% | `Support build_and_publish volumes and deployment volume UI (#147` |
| `2026-07-03-fix-named-volume-bind-source`                             | PR #1482       |      100% | `Fix deployment named volume bind sources (#1482)`                 |
| `2026-07-03-recoverable-acp-session-errors`                           | PR #1483       |      100% | `Recoverable ACP session errors (#1483)`                           |
| `2026-07-04-file-preview-v2`                                          | PR #1508       |      100% | `Implement File Preview v2 (#1508)`                                |
| `2026-07-04-project-compute-credential-attribution`                   | PR #1507       |       93% | `Wave 5 project credential attribution pins (#1507)`               |
| `2026-07-05-compute-credential-overrides`                             | PR #1511       |      100% | `Fix project-level compute credential overrides (#1511)`           |
| `2026-07-06-signup-approval-config`                                   | direct-to-main |       94% | `feat: add runtime signup approval setting`                        |
| `2026-07-07-first-run-admin-setup-wizard`                             | PR #1528       |      100% | `feat: first-run admin setup wizard with DB-backed platform confi` |
| `2026-07-07-origin-tag-injected-messages-persist-hide`                | PR #1569       |      100% | `feat(chat): origin-tag & collapse SAM-injected prompt text (pers` |
| `2026-07-07-preserve-acp-contentblock-meta-annotations`               | PR #1531       |       40% | `vm-agent: read inbound ACP block _meta/annotations; guard SDK ou` |
| `2026-07-08-cf-container-vm-agent-standalone-spike`                   | PR #1544       |      100% | `SPIKE: run standalone vm-agent in Cloudflare Sandbox (#1544)`     |
| `2026-07-10-cf-container-runtime-assets`                              | PR #1561       |       93% | `Runtime-neutral env/file/secret injection for instant cf-contain` |
| `2026-07-10-fix-instant-workspaces-prod-deploy`                       | direct-to-main |       50% | `Stabilize VM-agent deployment apply watchdog test`                |
| `2026-07-11-cf-container-cold-start-latency`                          | PR #1570       |      100% | `chore: record pr1566 production validation (#1570)`               |
| `2026-07-11-taskrunner-d1-lifecycle-reconciliation`                   | PR #1567       |       86% | `fix: reconcile dead TaskRunner DO/D1 lifecycle promptly (Priorit` |
| `2026-07-11-upgrade-codex-acp-wrapper`                                | direct-to-main |       92% | `Upgrade Codex ACP wrapper package`                                |
| `2026-07-13-refresh-supported-agent-model-catalog`                    | direct-to-main |       89% | `chore: refresh agent model catalog`                               |
| `2026-07-14-fix-cloud-init-runcmd-shell-mismatch`                     | PR #1582       |       71% | `fix(cloud-init): make Caddy runcmd POSIX-compatible (#1582)`      |
| `2026-07-15-deployment-custom-domain-lifecycle`                       | PR #1602       |      100% | `Fix deployment custom domain lifecycle (#1602)`                   |
| `2026-07-15-joint-cto-review-prs`                                     | direct-to-main |       75% | `docs: record final joint PR CI evidence`                          |
| `2026-07-16-fix-sessions-list-internal-error-large-projects`          | PR #1613       |       54% | `fix(chat): tolerate malformed session rows in sessions-list read` |
| `2026-07-16-shared-project-runtime-git-token`                         | PR #1607       |      100% | `Fix shared-project runtime resources and git tokens (#1607)`      |
| `2026-07-17-full-app-ux-audit`                                        | direct-to-main |       n/a | `fix(ui): re-align active tab when scroll-snap leaves it clipped ` |
| `2026-07-18-cto-remediation-mega-pr`                                  | direct-to-main |       55% | `Integrate CTO remediation hardening PRs`                          |
| `2026-07-21-instant-runtime-recovery-state-machine`                   | PR #1660       |      100% | `fix: recover Instant sessions across runtime loss (#1660)`        |
| `2026-07-23-codex-guided-setup-terminal`                              | PR #1664       |        0% | `feat: Codex guided setup terminal (Cloudflare Sandbox device-aut` |
| `2026-07-23-digitalocean-cloud-provider`                              | PR #1670       |      100% | `feat: add DigitalOcean cloud provider and Block Storage (#1670)`  |
| `2026-07-25-add-claude-opus-5-model-catalog`                          | PR #1665       |       87% | `feat(models): add Claude Opus 5, prune retired Sonnet 4, fix sta` |
| `2026-07-25-infomaniak-cloud-provider`                                | PR #1668       |       93% | `feat(providers): add Infomaniak Public Cloud (#1668)`             |
| `2026-07-25-native-codex-guided-login`                                | PR #1666       |       84% | `feat: replace Codex setup terminal with native guided login (#16` |
| `2026-07-25-upcloud-cloud-provider`                                   | PR #1669       |       74% | `feat(providers): add UpCloud BYO-key cloud provider (#1669)`      |
| `2026-07-29-phase-05-debugging-agent`                                 | PR #1688       |       94% | `feat: add standalone deployment debugging agent (#1688)`          |
| `2026-07-29-strict-cto-remediation-mega-pr`                           | PR #1697       |       40% | `Integrate strict CTO remediation fixes (#1697)`                   |
| `2026-08-03-durable-long-request-handling`                            | PR #1722       |       95% | `Make diagnoses and instant starts durable (#1722)`                |
| `2026-08-04-auto-run-html-artifact-preview`                           | PR #1735       |      100% | `feat(web): auto-run HTML artifact previews full-bleed (#1735)`    |
| `2026-08-04-durable-admin-diagnosis-runner`                           | PR #1736       |       91% | `Make admin diagnostic runs durable, inspectable, and reliable (#` |
| `2026-08-05-complete-local-debugging-experience`                      | PR #1750       |       89% | `Complete the same-instance debugging experience (#1750)`          |
| `2026-08-05-r5-dependency-supply-chain-pinning`                       | PR #1747       |       75% | `chore: harden dependency governance pins (#1747)`                 |
| `2026-08-05-self-host-wizard-memory-only-secrets`                     | PR #1741       |      100% | `Keep self-host generated secrets memory-only (#1741)`             |
| `2026-08-06-fix-codex-bwrap-all-runtimes`                             | PR #1757       |       91% | `fix(vm-agent): disable Codex bwrap across all runtimes (#1757)`   |
| `2026-08-07-debugging-experience-overhaul`                            | PR #1765       |       n/a | `Debugging experience overhaul: failure visibility, correlation, ` |
| `2026-08-08-blocking-workspace-quality-surfaces`                      | PR #1774       |       91% | `WP-065: Make workspace quality surfaces blocking (#1774)`         |
| `2026-08-08-provider-request-cancellation`                            | PR #1773       |      100% | `WP-107: Preserve caller cancellation through provider requests (` |
| `2026-08-09-correlate-vm-incidents-with-task-lifecycle`               | direct-to-main |      100% | `docs(tasks): record diagnostic correlation validation`            |
| `2026-08-09-deterministic-runtime-boundary-quality`                   | PR #1784       |       64% | `quality: add deterministic runtime-boundary program (#1784)`      |
| `2026-08-09-fix-runaway-cost-control-loops`                           | PR #1777       |        0% | `Fix runaway-cost and infinite-loop control paths (#1777)`         |
| `2026-08-09-integrate-durable-execution-foundations`                  | PR #1785       |      100% | `feat: add durable session sleep and recovery for Claude Code and` |
| `2026-08-09-vm-agent-durable-execution-foundation`                    | PR #1785       |       82% | `feat: add durable session sleep and recovery for Claude Code and` |
| `2026-08-09-worker-projectdata-durability-foundation`                 | PR #1785       |       85% | `feat: add durable session sleep and recovery for Claude Code and` |
| `2026-08-11-buzz-sam-acp-prototype`                                   | PR #1805       |      100% | `experiment: prototype Buzz ACP bridge to SAM (#1805)`             |
| `2026-08-11-fix-marketing-pages-wrangler-resolution`                  | PR #1806       |       88% | `fix(ci): restore marketing Pages deployments (#1806)`             |
| `2026-08-11-web-push-human-input`                                     | direct-to-main |       98% | `chore: record web push PR evidence`                               |
| `2026-08-12-persistent-session-sleep-wake`                            | PR #1785       |       87% | `feat: add durable session sleep and recovery for Claude Code and` |
| `2026-08-12-secure-d1-restore-inputs`                                 | direct-to-main |       89% | `task: link D1 restore security PR`                                |
| `2026-08-14-fix-stranded-session-sleep-cleanup`                       | direct-to-main |       96% | `docs(sessions): describe legacy upload relay`                     |
| `2026-08-15-fix-production-snapshot-sleep-timeouts`                   | PR #1828       |       89% | `Fix production snapshot sleep timeouts (#1828)`                   |
| `2026-08-15-scheduler-lifecycle-race-lab`                             | direct-to-main |      100% | `docs(tasks): record scheduler security review`                    |
| `2026-08-16-fix-session-snapshot-pipeline`                            | PR #1836       |       94% | `Fix session snapshot direct upload wake pipeline (#1836)`         |
| `2026-08-16-prevent-gcp-default-service-account`                      | direct-to-main |       79% | `fix(gcp): prevent default service account attachment`             |
| `2026-08-16-session-activity-state-machine`                           | PR #1840       |      100% | `fix(api): reconciled session-activity state machine with probe-b` |
| `2026-08-18-cache-auth-preamble-platform-config`                      | direct-to-main |      100% | `perf: auth preamble per-isolate cache with platform-config file ` |
| `2026-08-18-chat-dom-bound-d1-session-summary-index`                  | PR #1859       |      100% | `perf: bound chat DOM weight and serve the project session list f` |
| `2026-08-18-query-cache-persistence-and-http-cache-headers`           | PR #1858       |      100% | `perf: TanStack Query cache persistence + HTTP Cache-Control head` |
| `2026-08-18-ui-perf-chat-poll-and-memo-quick-wins`                    | PR #1849       |      100% | `perf(web): gate chat polls on WS liveness and tab visibility, me` |
| `2026-08-18-web-route-code-splitting`                                 | PR #1850       |      100% | `perf(web): route-level code splitting — entry chunk 854→77 kB gz` |
| `2026-08-19-browser-side-conversation-caching`                        | direct-to-main |      100% | `Implement browser-side chat message caching`                      |
| `2026-08-19-ensure-branch-exists-before-instant-workspace`            | PR #1863       |      100% | `fix(api): ensure the checkout branch exists before launching an ` |
| `2026-08-19-server-side-kv-caching`                                   | direct-to-main |      100% | `perf: cache project files and triggers data`                      |
| `2026-08-21-message-anchored-commenting-backend`                      | PR #1882       |       91% | `feat: add message-anchored commenting MVP (#1882)`                |
| `2026-08-21-message-anchored-commenting-ui`                           | PR #1882       |      100% | `feat: add message-anchored commenting MVP (#1882)`                |
| `2026-08-21-private-feedback-incident-backlog`                        | direct-to-main |       92% | `Add admin feedback project configuration`                         |
| `2026-08-21-projectdata-storage-safety-firebreak`                     | PR #1875       |      100% | `ProjectData storage safety firebreak (#1875)`                     |
| `2026-08-21-session-idleness-work-lease-slice`                        | PR #1874       |       95% | `fix: normalize session idleness for ACP tool work (#1874)`        |
| `2026-08-21-vm-admission-control`                                     | PR #1876       |      100% | `Add VM admission control and node-packing backpressure (#1876)`   |
| `2026-08-22-library-file-commenting`                                  | PR #1889       |      100% | `feat(library): comment on markdown files in the project library ` |
| `2026-08-23-policy-lifecycle-controls`                                | PR #1893       |       81% | `feat(policies): expiry + scope lifecycle controls (token-optimiz` |
| `2026-08-24-fix-comments-navigation-followup`                         | PR #1898       |       89% | `Fix comments navigation deep links (#1898)`                       |
| `2026-08-24-project-comment-inbox-endpoint`                           | PR #1897       |      100% | `Ship comment navigation UI with project inbox endpoint (#1897)`   |
| `2026-08-24-taskrunner-handoff-mismatch-bookkeeping`                  | PR #1899       |      100% | `fix(api): suppress normal TaskRunner handoff mismatch warnings (` |
| `2026-08-25-completiondock-activity-coalescing`                       | PR #1906       |      100% | `Fix CompletionDock activity twitch from ACP reports (#1906)`      |
| `2026-08-25-fix-task-runtime-liveness-heartbeat-classifier`           | direct-to-main |      100% | `Fix task liveness stale node heartbeat classifier`                |
| `2026-08-25-on-demand-comment-rail-mobile-overlay`                    | PR #1907       |       92% | `Fix on-demand chat comment surfaces (#1907)`                      |
| `2026-08-26-incident-triage-ship-or-track`                            | PR #1929       |       88% | `Enforce ship-or-track incident triage resolutions (#1929)`        |
| `2026-08-26-preserve-restorable-sleeping-sessions`                    | direct-to-main |       94% | `Fix sleeping session archive during teardown`                     |
| `2026-08-26-private-feedback-incident-triage`                         | PR #1927       |       92% | `Resolve private API incident liveness gaps (#1927)`               |
| `2026-08-26-projectdata-storage-safety-warning-alerts`                | direct-to-main |       94% | `Fix ProjectData storage warning alerts and cleanup reach`         |
| `2026-08-26-projectdata-tool-payload-r2-archival`                     | direct-to-main |       96% | `Archive ProjectData tool payloads to R2`                          |
| `2026-08-26-shared-agent-session-closure-finalizer`                   | PR #1917       |       72% | `Centralize workspace lifecycle finalization (#1917)`              |
| `2026-08-26-workspace-ports-polling-readiness`                        | PR #1918       |       93% | `Fix workspace ports polling readiness (#1918)`                    |
| `2026-08-27-checkin-watchdog-busy-agents`                             | direct-to-main |      100% | `Fix SAM check-in watchdog for busy agents`                        |
| `2026-08-27-compute-pools-wave-0-invariants`                          | direct-to-main |      100% | `test: pin compute pool placement invariants`                      |
| `2026-08-27-compute-pools-wave-1a-schema`                             | direct-to-main |      100% | `feat: add capacity pool schema foundation`                        |
| `2026-08-27-projectdata-retention-convergence`                        | PR #1940       |       87% | `Make ProjectData tool payload retention converge safely (#1940)`  |
| `2026-08-28-capacity-pools-wave-3b-api-ui`                            | direct-to-main |      100% | `feat: expose default capacity pools`                              |
| `2026-08-28-default-capacity-pools-wave-2b`                           | direct-to-main |      100% | `fix: address provider-native pool review gaps`                    |
| `2026-08-28-repair-compute-pool-default-editing`                      | PR #1963       |      100% | `Repair default compute pool editing (#1963)`                      |
| `2026-08-29-compute-pools-integration-quality-pass`                   | direct-to-main |      100% | `test: strengthen compute pool visual evidence`                    |
| `2026-08-30-record-task-supersession-active-agent-counts`             | direct-to-main |       98% | `fix: preserve staging-applied supersession migration`             |
| `2026-08-30-vm-agent-active-resource-monitoring`                      | PR #1980       |       82% | `Layered VM resource management: cgroup isolation, monitoring, ev` |
| `2026-08-30-vm-agent-cgroup-resource-isolation`                       | PR #1980       |      100% | `Layered VM resource management: cgroup isolation, monitoring, ev` |
| `2026-08-31-projectdata-pre-wall-storage-relief`                      | PR #1978       |      100% | `ProjectData pre-wall storage relief (#1978)`                      |
| `2026-08-31-projectdata-terminal-archive-sharding`                    | PR #2022       |        0% | `fix(project-data): sub-batch archive chunk verification below th` |
| `2026-08-31-tool-rail-tab-placement`                                  | PR #1977       |       57% | `Finalize session tool rail: lower tab, remove review knob, works` |
| `2026-09-01-add-claude-fable-51-model-catalog`                        | PR #2001       |       89% | `Add Claude Fable 5.1 model support (#2001)`                       |
| `2026-09-01-archive-sharding-rollout-controls`                        | PR #2000       |      100% | `Add archive-sharding rollout controls (#2000)`                    |
| `2026-09-01-fix-stopped-session-sleep-repair`                         | direct-to-main |      100% | `Fix sleep repair for stopped ProjectData sessions`                |
| `2026-09-01-fix-stopping-sleep-repair-starvation`                     | PR #1985       |      100% | `Fix stopping sleep repair starvation (#1985)`                     |
| `2026-09-01-weekly-website-claims-audit`                              | PR #1982       |       90% | `docs: update website claims audit roadmap wording (#1982)`        |
| `2026-09-02-manual-projectdata-cleanup-and-sharding-cadence`          | direct-to-main |      100% | `docs(task): record projectdata cleanup PR evidence`               |
| `2026-09-03-session-stop-cancel-flow-fixes`                           | PR #2011       |      100% | `Fix interrupt reliability and post-interrupt unresponsiveness in` |
| `2026-09-04-aggregate-workspace-resource-reservations`                | PR #2021       |       87% | `fix(api): reserve aggregate node capacity atomically (#2021)`     |
| `2026-09-04-archive-sharding-bind-variable-limit`                     | PR #2022       |      100% | `fix(project-data): sub-batch archive chunk verification below th` |
| `2026-09-04-sam-daily-bot-journal`                                    | PR #2018       |       86% | `docs(blog): add SAM storage preflight journal (#2018)`            |
| `2026-09-06-sam-archive-drain-journal`                                | PR #2028       |       92% | `docs(blog): publish archive drain journal (#2028)`                |
| `2026-09-08-compact-shards-r2-history`                                | PR #2034       |       91% | `Reduce archive SQL write amplification with budgeted R2 history ` |
| `2026-09-08-legacy-node-credential-proof-undeletable`                 | direct-to-main |      100% | `fix(nodes): report only the placement field that is actually abs` |
| `2026-09-08-restored-host-restart-context-ownership`                  | PR #2039       |       n/a | `fix(vm-agent): restart a restored session host with the host's o` |
| `2026-09-08-sleep-queue-starvation`                                   | PR #2035       |       88% | `fix: unblock sleep queue and preserve final task responses (#203` |
| `2026-09-09-document-compute-pools`                                   | PR #2050       |      100% | `docs: explain compute (node) pools on the docs site (#2050)`      |
| `2026-09-09-hetzner-412-placement-blocks-fallback-chain`              | PR #2052       |       94% | `Fix Hetzner 412 placement errors halting the capacity-pool fallb` |
| `2026-09-09-publish-sam-task-startup-journal`                         | PR #2053       |       82% | `docs(blog): publish task-start journal (#2053)`                   |
| `2026-09-10-claude-instruction-context-optimization`                  | PR #2056       |      100% | `Reduce Claude startup instruction context (#2056)`                |
| `2026-09-10-publish-sam-wake-reliability-journal`                     | PR #2057       |       85% | `docs(blog): publish wake reliability journal (#2057)`             |
| `2026-09-10-wake-attempt-budget-strands-sessions`                     | PR #2054       |       92% | `Stop transient wake failures from permanently stranding sleeping` |
| `2026-09-11-agent-version-content-identity-and-cpu-admission`         | PR #2063       |      100% | `Stop every deploy and every busy CPU from evicting reusable node` |
| `2026-09-11-defer-busy-build-node-placement`                          | PR #2065       |      100% | `Defer placement on busy build nodes (#2065)`                      |
| `2026-09-11-legacy-sizing-bin-packing`                                | PR #2068       |       88% | `Adjust legacy workload slices for bin packing (#2068)`            |
| `2026-09-11-publish-sam-atomic-release-journal`                       | PR #2067       |       85% | `docs(blog): publish atomic release journal (#2067)`               |
| `2026-09-12-deadlocked-projectdata-archive-sweep-budget-mismatch`     | PR #2069       |       83% | `Fix deadlocked ProjectData archive sweep: derive the selection c` |
| `2026-09-13-fix-instant-container-sleep-leak`                         | PR #2071       |      100% | `fix: reconcile instant sessions missing sleep intents (#2071)`    |
| `2026-09-14-enable-tool-payload-cleanup-and-raise-archive-throughput` | PR #2080       |       32% | `Make an inert ProjectData cleanup observable, and buy the archiv` |
| `2026-09-14-marketing-site-feature-refresh`                           | PR #2082       |      100% | `www: refresh marketing site with multiplayer, comments, compute ` |
| `2026-09-16-project-sidebar-scrollable-short-viewport`                | PR #2092       |      100% | `Make the project sidebar nav scrollable on short viewports (#209` |
| `2026-09-16-switch-task-title-model-to-gemma`                         | PR #2093       |       90% | `Switch task title generation default to Gemma (#2093)`            |
| `2026-09-17-publish-sam-archive-timeout-journal`                      | PR #2095       |       92% | `docs: publish SAM archive timeout journal (#2095)`                |
| `2026-09-18-polish-project-events-page-ui`                            | PR #2098       |        0% | `Polish Events page: icons, state colors, empty states, auto-refr` |
| `2026-09-19-port-app-deployment-fixes-and-dedupe-pending-release`     | direct-to-main |      100% | `Port app-deployment race and liveness fixes`                      |
| `2026-09-20-archive-sweep-throughput-step3`                           | PR #2109       |       n/a | `fix: raise archive sweep message budget to 10000 (step 1) (#2109` |
| `2026-09-20-resource-based-scheduler-packing`                         | PR #2108       |       92% | `Migrate scheduler packing to explicit resources (#2108)`          |
| `2026-09-20-workspace-resource-history`                               | PR #2110       |       93% | `Add per-workspace resource history (#2110)`                       |
| `2026-09-21-deployment-node-pool-strategy`                            | PR #2114       |       92% | `Add deployment-specific node pool placement (#2114)`              |
| `2026-09-21-incremental-materialization-on-sleep`                     | PR #2117       |       91% | `Make sleeping chat sessions searchable with incremental material` |
| `2026-09-22-legacy-deployment-node-adoption`                          | PR #2121       |      100% | `fix(deploy): let agents target environments parked in error (#21` |
| `2026-09-22-projectdata-archive-copy-reliability-slice-a`             | PR #2133       |       95% | `fix(api): resume verified ProjectData archive copies (#2133)`     |
