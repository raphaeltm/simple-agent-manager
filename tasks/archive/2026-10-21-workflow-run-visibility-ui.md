# Workflow run visibility: read API and Automation UI

## Problem

The durable workflow foundation (`start_workflow_run` / `get_workflow_run`, branch
`sam/use-sam-mcp-tools-mdxs8p` @ `6293190b6`, release owner task `01M5G452PW1S6E2XGZV9G8ZS5Y`)
lets an agent submit a dependency graph that SAM advances on its own. Nobody but the
submitting agent can see a run: there is no REST read and no UI. Raphaël authorized (2026-10-21)
project-level workflow visibility as the second of three slices, with all UI owned by the
Opus 5.5 Chat profile (this task, `01M5G463QWVXX188N4651EXVW7`).

Deliver: an authenticated read API (list + detail) and project UI inside the existing
Automation surface — run list, run detail with a dependency graph, each step's status,
predecessor inputs, outputs (summary, branch, PR, artifact refs, reported evidence), linked
agent chats, honest actionable failure reasons, and the step view contract that the next
backend slice (durable event-wait steps) will fill without UI changes. Terminology:
"workflow" / "run". No new top-level nav, no visual editor, no templates, no controls the
engine does not support (no retry/skip/pause/cancel/create); creation stays MCP-only.

## Research findings

- Engine data (foundation): `missions` rows with `workflow_plan_json IS NOT NULL` are runs;
  `mission_steps` (state `waiting|starting|running|completed|failed|blocked`, `after_json`,
  `profile_snapshot_json`, `task_id`/`session_id` reserved up front, `submission_json` set at
  launch, `result_json` {summary, branch, prUrl, completionEvidence, handoffs[{id, artifactRefs[{type, ref}]}]},
  `reason`, `launch_retries`); `mission_workflow_events` (deliveryKey id, `workflow.step.<state>`,
  `workflow.run.completed|needs_attention`, payload metadata `stepId`). Stored run status
  `failed` reads as `needs_attention` (`workflow-runs.ts:getWorkflowRun`).
- MCP `getWorkflowRun` is owner-only with current `task:write`. Existing missions REST
  (`routes/missions.ts`) and shared-project visibility (idea `01KVX4YP9C5255TEB28PGM1159`:
  everything visible to all members) use `task:read`. Design idea `01M59MBMZJVYHPHH1GJ7X8TZT1`:
  workflow CONTROL is single-user; visibility follows existing project visibility.
  Decision: REST reads require active membership with `task:read`; MCP stays owner-only.
- DRY policy 5cb362e8: one shared read operation, surfaces adapt transport/output. Extract
  the run/step/activity load into a shared read model used by MCP `get_workflow_run` (output
  unchanged) and the REST routes.
- Step tasks get `tasks.mission_id = run.id`, `parent_task_id = root_task_id`; chats live at
  `/projects/:id/chat/:sessionId`. `session_id` is reserved before launch, so the UI links a
  step chat only once its task row exists (live `tasks` read).
- `result_json.completionEvidence` is the task's JSON evidence string sliced to
  `handoffMaxChars`; a long value becomes invalid JSON. Parse with
  `parseCompletionEvidenceJson` (returns null on failure) and fall back to the chat.
- Foundation bug found: `publish_handoff` documents artifact refs as `{type, path}` but the
  engine requires `{type, ref}` and fails the step. Reported on `feature.workflows`
  (event `056eac8e`); engine fix belongs to the foundation owner.
- A ready step can stay `waiting` with no reason (parallel cap `workflow.maxParallelSteps`,
  per-cycle launch budget, alarm not yet ticked). Show "Ready — starts shortly (up to N at
  once)" using the resolved config rather than inventing a reason.
- Automation UI style (knowledge UIUX, PR #2381 era): "Needs your attention" first with the
  fix as a button; plain words; IDs under "Advanced"; status pills only for exceptions in lists;
  44 px targets; `flex flex-col gap-*` (never `space-y-*`); shared primitives in
  `pages/automation/ui.tsx` + `page.tsx`; TanStack Query (rule 48); polling via
  `refetchInterval` (pauses on hidden tab).
- Prior UX exploration (option B, prototype branch `sam/design-exploration-only-create-h66dyh`,
  reference only): checklist grouped into stages "First / Then · at the same time / Finally";
  one-segment-per-step progress bar; graph via the Account Map's React Flow + dagre
  (`components/account-map/layout/dagre-layout.ts`), top-to-bottom when narrow, left-to-right
  for wide fan-outs; graph adds little on phones, so Steps is the phone default.
- Routing: `automation/:kind/:automationId` exists; static `automation/workflows/:runId` ranks
  higher in React Router, so no collision.
- I/O budget (rule 60): list = auth + 1 page query + 1 batch (steps, owners); detail = auth +
  run + 1 batch (steps, activity, tasks, owner). Both ≤ 8 round trips.
- Rule 50: per-row parse isolation for list/detail (skip/log malformed rows, never 500 the page).
- Rule 28/11: project scoping is a SQL predicate → test against real D1 with a foreign-project
  attack case and an owner-path control, and prove discriminating.

## Implementation checklist

### Contract and API

- [x] Shared types `packages/shared/src/types/workflow.ts` (statuses as const lists, list/detail response types, event-wait step view) exported from the shared index.
- [x] Shared read model `apps/api/src/services/workflow-run-read.ts`: load run + steps + activity + linked tasks + owner in bounded queries; per-row isolation; projections for REST detail/list.
- [x] MCP `getWorkflowRun` reuses the shared loader with unchanged output shape.
- [x] REST `GET /api/projects/:projectId/workflows` (status filter, cursor, limit clamp) and `GET /api/projects/:projectId/workflows/:runId`; per-route auth; `task:read`; non-disclosing 404.
- [x] Worker tests (real D1): list/detail happy path through the real engine, status filter + cursor paging, viewer access, non-member 404, foreign-project run 404 (attack + owner control), malformed step row tolerated, MCP output unchanged.
- [x] Publish UI/read contract + event-wait step view on `feature.workflows`.

### Web UI

- [x] API client + query options (`lib/api/workflows.ts`, `lib/query-options/workflows.ts`), identity-scoped keys, active-run polling (`VITE_WORKFLOW_RUN_POLL_MS`).
- [x] Routes `automation/workflows`, `automation/workflows/:runId` (lazy) + `automationPaths.workflows/workflow`.
- [x] Workflow view model (pure): stages, plain-language step status lines, recovery action from structure, progress counts, attention selection.
- [x] Workflows list page: groups (Needs attention / Running / Finished), filter chips, progress bar, empty state explaining MCP-only start, load-more, error/loading states.
- [x] Run detail page: header (status, starter, started-from chat, deadline), progress, attention callout with real actions (open chat / view step), tabs Steps · Graph · Activity, step detail (instructions, inputs from predecessors, outputs, evidence labelled agent-reported, chat link, Advanced IDs), About this run.
- [x] Graph: React Flow + dagre reuse, status-coloured edges, node select, lazy-loaded.
- [x] Event-wait rendering (kind `wait`): listening/heard/timed-out wording, timeout display.
- [x] Automation overview: workflows needing attention in "Needs your attention"; Workflows panel with running/recent runs and link to the list.
- [x] Unit tests (view model + rendered pages with realistic data, attention selection, wait steps, links).
- [x] Playwright visual audit (375 + 1280; normal, long text, empty, many/25 steps, wide fan-out, failure, wait step, error) with `assertNoOverflow`; screenshots reviewed.

### Docs

- [x] `docs/guides/durable-workflows.md`: REST reads + UI location; public docs page under `apps/www/src/content/docs/docs/` for following a workflow run; api-reference skill.

### Release

- [x] Rebase onto main after the foundation PR merges (never write the foundation branch): main `2585626df` merged in `cf4590f17` (identical tree to the already-merged foundation head).
- [x] Specialist reviews (task-completion, UI/UX, security, cloudflare, test, constitution, doc-sync, performance, architecture): all PASS; findings addressed in `e3721bb72` (index deferred to Idea `01M5GBDQVPT4XQM2M7VNFBSY95`).
- [x] Staging: coordinate window on `feature.workflows`; real run visible in UI end to end; ≤2 VMs, zero at rest. Deploy `39691437574` green; Playwright 99/100 on the real runs (the miss was cold-start latency, re-measured 3–9 s); no VMs started; 0 active nodes/workspaces at 23:38Z.
- [x] PR with UI screenshot evidence, CI green, CodeRabbit request+wait, merge, production deploy + smoke: this PR. This file reaches `main` only when the PR merges; the production deploy and smoke are monitored after the merge and reported on `feature.workflows`.

## Acceptance criteria

1. A project member opens Automation → Workflows and sees every workflow run in the project, needs-attention first, with per-step progress.
2. The run page shows the dependency graph with each step's status, and every step's instructions, inputs from its prerequisites, outputs (summary, branch, PR, artifact references, agent-reported evidence) and a link to its agent chat once it exists.
3. Failures read honestly: the failing step, the engine's reason verbatim, what did not start because of it, and a real next action (open the chat; start a new run via an agent). No control the engine lacks is shown.
4. A step of kind `wait` renders listening / heard / timed out with its timeout, from the published contract, without further UI work.
5. Non-members and other projects' runs return 404; viewers can read; MCP `get_workflow_run` output is unchanged.
6. Mobile (375px) and desktop (1280px) layouts pass overflow audits with stress data.

## References

- `docs/guides/durable-workflows.md`, `apps/api/src/services/workflow-runs.ts`, `workflow-reconcile.ts`
- Idea `01M59MBMZJVYHPHH1GJ7X8TZT1`; knowledge UIUX, WorkflowFeatureDelivery
- Rules 02, 11, 28, 48, 50, 56, 60, 62, 64, 65, 79

## Implementation notes

- 2026-10-21 21:3xZ: read API committed `519e549d4`. Worker tests (`tests/workers/workflow-run-read-routes.test.ts`, 9) + foundation suite (19) green. Discrimination proven: removing `project_id = ?` from `loadWorkflowRun` reddens the cross-project attack test; removing `requireProjectTaskRead` from the detail route reddens the access test. `quality:runtime-boundary-semantics` required valibot row schemas instead of `as Row[]` casts.
- Branch merged foundation head `ddf4b8f88` (includes main `d4b87b304`) instead of rebasing, to avoid force-pushing the output branch.
- turbo injects a block into AGENTS.md when it detects an agent; revert it before every commit.
- 2026-10-21 22:2xZ: web UI committed `3f02b81dc` (list, run page with Steps/Graph/Activity, step details, overview sections, event-wait view). Playwright audit `workflow-runs-audit.spec.ts` 54/54 at 375/390/1280 plus the existing Automation audit 42/42. Real bug found by the 25-step fixture: React Flow fit-view shrank nodes to ~13px, fixed with a 0.75 minimum zoom, sideways scroll centred on the selected step, and a hint.
- Unit tests `e9d6d469e` (28): view model + rendered pages. Discrimination: removing the 3-day attention window reddens the overview test; polling finished runs reddens the polling test.
- Docs: public guide `guides/workflows.md` (3 compressed screenshots from `docs-screenshots-workflows.spec.ts`), Automation guide, admin-settings table for `workflow.*` (the foundation added the settings without public docs), contract doc "Reading runs", api-reference section. `www` build, link check (0 broken) and tests (94) pass.
- 2026-10-21 22:5xZ: nine local reviewers, all PASS. Fixed: shared `useMediaQuery` (architecture HIGH: three copies of the matchMedia hook plus mine), run-page tab ARIA and arrow keys, "Done" group wording, focusable wide graph, content-free skip logs (security), activity read no longer truncated by a formula (bound named from the writer's delivery keys), MCP status mapping kept exactly, `WorkflowArtifactRef` derived from `HandoffArtifactRef`, configuration reference rows. New tests (each proven discriminating by breaking its guard): malformed run mid-list with paging past it, 101-run list beyond one D1 bind batch, no row content in skip logs, hidden-tab polling pause, tab keys, `useMediaQuery`. Deferred with reasons: missions partial index (Idea `01M5GBDQVPT4XQM2M7VNFBSY95`), two overview list reads (the attention read never polls and is merged with the polled list).
- Foundation PR #2404 merged 22:56Z as `2585626df`; this branch merges main next.
