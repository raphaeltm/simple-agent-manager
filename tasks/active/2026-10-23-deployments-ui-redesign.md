# Deployments UI redesign: ship Take A with Take B's deploy steps

## Problem

Raphaël: "Some of the deployment UI is awkward." Two takes were prototyped and reviewed. The
report is in library `/engineering/ux-audits/deployments-2026-10-23/` (fileId
01M5NBQZ1FAVENE7QSJTDXQ0RN) and the prototype is on branch `sam/deployment-ui-awkward-provide-cj0p08`.
Then Raphaël asked: "If you had to pick and choose, what should we implement from both? Make a
decision and then make it happen. Get it green and ship to prod."

What's wrong today (evidence in the report):

- Statuses contradict each other. `deriveServiceState` treats any error message as not serving
  (`components/deployments/deployment-status.tsx:63`).
- There is no way to open the app from the list.
- Seven tabs; three are off-screen on a phone.
- Destroy sits next to Stop.
- Raw IDs everywhere.
- No release history, although the API has it.
- An empty allow-list silently means any agent may deploy (`deployment-control.ts:366`), so
  unticking the last profile widens access.
- The create form takes the top half of the phone screen.
- Manual Refresh buttons.

## Decision

Ship **Take A** (calm status page) as the structure, plus **Take B's live deploy steps**:

- **List:** grouped into Needs your attention / Running / Not running. Each row has its real
  address, who shipped the running version, and one action (Open, or Ask an agent). "New" opens a
  sheet with a required access choice.
- **Environment page:** one scroll.
  - Hero: status sentence, address with Open, Logs, and credit for the live version.
  - Problems with their fixes.
  - Recent deploys, with deploy steps for the newest release while it deploys or after it fails
    (from Take B).
  - Who can deploy: a switch that never grants by itself.
  - Settings your app reads, addresses (3-step domain sheet), saved data, Behind the scenes.
  - Pause and Delete at the bottom; Delete needs the name typed.
  - Desktop: an "On this page" index, and the shorter sections paired side by side.
- **Not now:** Take B's three panes and settings sheets, the project-wide activity feed, Roll back
  (no route). Tracked in idea 01M5NBRGEV68MMK65BV0BT06EP.

## Research findings

- `GET /api/projects/:projectId/environments/:envId/releases` (`routes/deployment-releases.ts:274`)
  returns no `submittedBy`. It lives in the manifest JSON (`releaseSubmittedBy`,
  `services/deployment-environment-summary.ts`). Read it with `json_extract`, not by loading every
  manifest.
- `deployment_release_events` is written by `appendDeploymentReleaseEvent`
  (`services/deployment-release-events.ts`) from the node callback, but no route reads it.
  `requireOwnedRelease(db, releaseId, envId)` exists. The table carries `project_id` and
  `environment_id`, so put both in the read predicate.
- VM agent event names (`packages/vm-agent/internal/deploy/engine.go`):
  - Each step reports `<step>_started` and `_completed`; some steps also report `_skipped` or
    `_verified`.
  - A failure is one `deployment.apply.failed` (or `failed_initial`) event.
  - A revert reports `revert_started`, then `deployment.apply.reverted` if it worked; a failed revert
    reports nothing more.
  - The event prefix can differ from the step key (`artifacts_load` → `load_artifacts`,
    `volume_mount` → `volume_mounts`).
- Heartbeats update only `active` and `starting` environments, and tell the node to retire the
  rest (`routes/node-lifecycle.ts:603`). So an `error` or stopped environment's observed version
  is frozen, not live.
- Start re-applies the **latest** release and resets it to `created` while the environment is
  `starting` (`markEnvironmentStarting`, `routes/deployment-environment-lifecycle.ts`).
- `applying` stops the old version first (`previous_down` before `compose_up`), so deploys cause
  downtime.
- `DeployStatus` and `DiskTelemetry` are never set by the agent (`deploy/types.go:56-58`). Read
  them only when present, in the agent's vocabulary (`deploy/status.go`).
- Lifecycle failure kinds are free text:
  - placement: `Deployment node placement …`
  - stop: `Stop failed …` (`markEnvironmentStopFailed`)
  - start: an `error` environment with no node linked
- The `unhealthy` node health means a longer silence than `stale`, not load
  (`services/node-health.ts:7-21`).
- Chat pre-fill pattern: `?executeIdea=<id>` in `pages/project-chat/useProjectChatState.ts:97`
  fills the composer from a fixed template, then strips the param. Mirror it with a validated
  environment name, so a link can't inject arbitrary prompt text.
- Polling cadences belong in `apps/web/src/lib/poll-intervals.ts` (a `DEFAULT_*` constant plus a
  `VITE_*` override; rule 60).
- Old UI to delete once replaced:
  - `components/deployments/DeploymentCustomDomainsPanel.tsx`, `DeploymentEnvironmentConfigPanel.tsx`,
    `DeploymentEnvironmentSummaryCard.tsx`, `DeploymentLogsPanel.tsx`, `DeploymentMetricsPanel.tsx`,
    `DeploymentVolumesPanel.tsx`, `deployment-card-format.ts`, and the parts of
    `deployment-status.tsx` that go unused
  - `components/EnvironmentSecretsSection.tsx`, which is already dead
  - their unit tests
- Playwright specs that target the old UI:
  - `deployment-control-surface-audit`, `deployment-volumes-audit`, `deployments-empty-state-audit`
    (local)
  - `staging-app-deployment-path` and `staging-deployment-config` (staging)
- Docs that describe the old UI: `apps/www/.../guides/app-deployments.md` (the Volumes and Domains
  tabs, Stop/Start, and the screenshot `/images/docs/deployment-custom-domains.png`).

## Implementation checklist

### API
- [x] Release list returns `submittedBy` per release (`json_extract`, no manifest load)
- [x] `GET …/releases/:releaseId/events`: auth, project and environment scoping in the predicate,
  ordered by seq, bounded, no `detail_json`
- [x] Tests for both against a real SQL engine (`createSqliteD1`), each with a cross-project attack
  case and an owner control

### Web
- [x] Move the Take A prototype and shared modules into `apps/web/src/pages/deployments/`; delete
  Take B and the `?take` switch
- [x] `ProjectDeployments.tsx` and `ProjectDeploymentEnvironmentDetail.tsx` render the new pages
- [x] Deploy steps (from Take B) inside Recent deploys for the newest release
- [x] Poll cadences in `lib/poll-intervals.ts`
- [x] "Ask an agent" pre-fills a new chat through a validated `deployHelp` parameter
- [x] Delete the old components, `EnvironmentSecretsSection`, and their now-dead tests
- [x] Unit tests: the model (health, problems, live version, steps, release outcome, domain state,
  failure kind)
- [x] Rendered behavior tests:
  - the who-can-deploy switch never grants by itself
  - the new-environment sheet requires an access choice
  - Delete needs the typed name
  - the deployHelp pre-fill
- [x] Playwright audit (`deployments-ui-audit.spec.ts`) at 375 and 1280, covering every state, long
  text, empty, and load errors
- [x] Update or replace the old Playwright specs, including the staging ones

### Docs
- [x] `guides/app-deployments.md`: section names, Pause/Start, and a new domains screenshot

### Review fixes (Phase 5)
- [x] ui-ux: trouble status takes the worst problem's tone; the hero says only what runs, the
  problem list says what went wrong
- [x] ui-ux: the "On this page" entry is "Delete" for a never-deployed environment
  (`pauseOrDeleteTitle`)
- [x] ui-ux: the profile chips scroll into view when "Only these" is picked; the Ask an agent
  divider runs the row's full height
- [x] performance: the list response carries each environment's routed custom domains
  (`listRoutedCustomDomainHostnames`, one query per list), so the list no longer fans out a
  domains read per environment
- [x] performance: the release list is bounded (`?limit`, default 50, max 200); the events read is
  two index-friendly queries instead of an `OR`
- [x] architecture: the automation page kit moved to `components/page-kit/` and the Deployments
  pages share it (one `CopyButton`, with a `quiet` variant, instead of a second copy icon)
- [x] architecture: Deployments query keys live in `lib/query-options/deployments.ts`
- [x] architecture: placement and stop failure prefixes are shared constants
  (`packages/shared/src/deployment-manifest/lifecycle-errors.ts`) that the API writes and the
  page reads
- [x] architecture: `environment.tsx` split (`hero.tsx`)
- [x] task-completion: the audit's clipped-overflow check is blocking; checked that it fails
  when an environment name can't wrap. Updated the stale row in
  `tasks/backlog/2026-08-11-clipped-overflow-debt-sweep.md`
- Not changed, with reasons in the PR: `StepMark` stays separate from the workflow step marks
  (a different state model); `since` stays local (one caller)
- Deferred LOW: cap the release manifest size at submission (idea 01M5NGDCZ8SKEN4YW3Y6M67R6M)

### Staging findings (2026-10-24)
- [x] Config spec passes on staging. A signed-in check passed 24/24 at 1280 and 375, with no
  console errors and no failed requests, covering the list, environment page, chat pre-fill and
  API shapes
- [x] 20 leaked `pw-cfg-*` test environments deleted from staging. They had no nodes, volumes or
  DNS. The spec's cleanup bug is fixed on this branch
- [x] Real apply events from staging, run through `collapseSteps`, read correctly. A skipped
  `compose_pull` was listed as "Pulled the images", so skip-only steps are now left out, with a
  regression test that replays the real sequence (7497e7f87)
- [x] The staging deploy spec's page opened behind the first-run setup modal and was still
  loading at 5 s. It now dismisses the modal and waits 30 s (77905c791)
- [ ] VM-backed spec (live page, pause from the page) on the final build

### Ship
- [x] `pnpm lint`, `pnpm typecheck`, and the affected tests, all green locally
- [x] Specialist reviews, recorded in the PR
- [ ] Staging deploy and live verification as a user
- [ ] PR with preflight evidence and UI screenshots; request CodeRabbit and wait
- [ ] Merge, then monitor Deploy Production to success

## Acceptance criteria

- [x] An environment with v43 failed and v42 serving reads "Needs attention: running version 42",
  lists "Version 43 didn't start" as its problem, credits v42, and shows v43's steps with the
  failed step and the revert (audit `environment — failed-deploy`, unit `describeHealth`)
- [x] A deploy in progress says the app is offline until it's up, and shows live steps
- [x] Turning agent deploys on never grants access without an explicit choice; "Only these" can't
  be saved empty
- [x] Delete requires typing the environment name
- [x] "Ask an agent" opens a new chat whose composer holds a request naming the environment
- [x] No horizontal overflow at 375 or 1280 with long names
- [ ] Works on staging against real environments, with zero errors
