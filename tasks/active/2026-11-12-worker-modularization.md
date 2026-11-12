# Worker modularization: split the API worker into focused packages

Requested by Raphaël on 2026-11-12 (coordinator task `01M77BJHHNW5714E98DEEMBCZA`).
Core branch: `sam/help-identify-parts-worker-embcza` (draft PR into `main`).
Coordination channel: `feature.worker-modularization`.

## Problem

`apps/api` holds about 361K lines of non-test source. 604 loose files sit in
`src/services/`. The glue is two hub files: `src/env.ts` (about 1,300 fields,
imported by 886 files) and `src/db/schema.ts` (imported by 473 files). Any
function that takes the whole `Env` cannot be lifted out of the worker, so
unrelated areas have grown into each other.

Measured 2026-11-12 on `b4ef3fba9` by grouping files on path and name (sizes
are approximate):

| Area                     | Lines | Imports N outside files | Imported by N outside files |
| ------------------------ | ----- | ----------------------- | --------------------------- |
| ProjectData              | 67K   | 48                      | 185                         |
| Compute and placement    | 42K   | 86                      | 208                         |
| MCP routes               | 23K   | 127                     | 14                          |
| App deployment           | 14K   | 48                      | 16                          |
| Operations               | 9K    | 68                      | 43                          |
| GitHub and GitLab        | 8K    | 26                      | 26                          |
| AI proxy                 | 6K    | 19                      | 16                          |
| Agent email              | 4K    | 15                      | 11                          |

## Goal

Each area below becomes a workspace package under `packages/` with an explicit
public entry point, its own narrow environment type, and no import from
`apps/api`. The worker wires the packages together. Behavior does not change.

## Workstreams

One draft PR per workstream, each targeting the core branch.

| ID  | Package                               | Branch                        | Wave |
| --- | ------------------------------------- | ----------------------------- | ---- |
| W0  | `@simple-agent-manager/worker-core`   | `sam/w0-worker-core-create-ervkbr`     | 1    |
| W1  | `@simple-agent-manager/project-data`  | `sam/w1-project-data-extract-f1wa0b`   | 1    |
| W2  | `@simple-agent-manager/scheduler-core`| `sam/w2-scheduler-core-extract-38pbbf` | 1    |
| W3  | `@simple-agent-manager/operations`    | `sam/w3-operations-turn-shared-4tsc50` | 1    |
| W4  | `@simple-agent-manager/app-deployment`| `sam/w4-app-deployment-extract-ngd1ke` | 1    |
| W5  | `@simple-agent-manager/ai-proxy`      | assigned at dispatch                   | 2    |
| W6  | `@simple-agent-manager/agent-email`   | assigned at dispatch                   | 2    |
| W7  | `@simple-agent-manager/repo-hosting`  | assigned at dispatch                   | 2    |

Wave 2 starts when W0 is merged into the core branch, so those three can use
the finished package template.

### W0: worker-core (foundation, critical path)

The small kernel every other package needs, so they do not each invent one.

- Move into the package: `lib/logger.ts` and what it needs
  (`credential-token-redaction`, `d1-error-code`), `lib/ulid.ts`,
  `lib/runtime-validation.ts` with `bounded-request-body`, `lib/d1-limits.ts`,
  the error helpers in `middleware/error.ts`, `services/fetch-timeout.ts` with
  `fetch-timeout-body`, and `db/schema.ts`.
- Leave a re-export file at each old path, so the hundreds of existing
  importers do not change in this PR.
- The logger must stop importing the full `Env`: give it the narrow type it
  actually reads.
- Establish the package template (package.json, tsconfig, vitest, lint) by
  copying `packages/providers`, and add it to the build order.
- Add a blocking lint check for the two boundary rules in "Rules for every
  workstream" below.
- Record the template and any decisions in this file under "Package template".
- Keep it small. Target: ready for review within about three hours, because
  seven workstreams wait on it.

### W1: project-data

- Scope: `durable-objects/project-data/**`, `services/project-data*.ts`,
  `project-data-archive/**`, and `scheduled/project-data-*` where it moves
  cleanly.
- The `ProjectData` class name and its export from the worker entry stay
  exactly as they are.
- It imports only 48 outside files. The ones to invert through ports include
  `task-runtime-liveness`, `session-recovery-authority`,
  `vm-prompt-delivery-adapter`, `sam-notice-builders`, `node-agent`,
  `telemetry`, `provider-limit-policy` and the Notification and
  VmAgentContainer objects.

### W2: scheduler-core

- Scope: the placement and capacity decision logic that has no database or
  Cloudflare dependency (about 6K lines): `placement-strategy`,
  `placement-capacity-ranking`, `placement-resolver-capacity*`,
  `placement-field-resolution`, `placement-resolver-types`,
  `placement-authority*`, `placement-diagnostics`, `placement-rollout`,
  `placement-resolution-error`, `capacity-pool-precedence`,
  `capacity-pool-authority`, `capacity-pool-workload-roles`,
  `capacity-placement-snapshot`, `workspace-resource-capacity`,
  `resource-requirements-input`, `provider-limit-policy`,
  `provisioning-attempt-limits`.
- Out of scope: everything that reads or writes D1. The compare-and-swap
  reservations are the scheduler's correctness and stay in the worker.
- Read the Library file `/engineering/research/extracting-the-scheduler.md`
  first.
- The scheduler simulation tests (`apps/api/tests/simulation`) must keep
  passing, ideally against the package.

### W3: operations

- Scope: `src/operations/**` becomes the package, with ports for what it needs
  from the worker.
- Then move tool logic that is duplicated between `routes/mcp` and
  `durable-objects/sam-session` onto shared operations, as far as fits one
  reviewable PR. Do not rewrite all 23K lines of MCP routes.
- Read idea `01M4GJ0W0DS5BTKBM1YW0X5YC8` and project policy
  `5cb362e8-ed6e-4544-a0c2-d387754c4c1e` first.

### W4: app-deployment

- Scope: `services/deployment*`, `services/compose*`,
  `services/image-resolver*`, `scheduled/compose*`. Routes stay in the worker
  as thin adapters unless one moves without dragging auth middleware along.
- Worker side only. The VM agent's Go `deploy` and `publish` packages are a
  later wave.
- Open PR #2605 touches deployment build contexts. Check its files and avoid
  rewriting the same lines.

### W5: ai-proxy

- Scope: `services/ai-*`, `routes/ai-proxy*`, `AiTokenBudgetCounter`.
- It depends on credentials (10 imports). Take those through a port.
- Stays in the same deployed worker. A separate Worker is a later decision.

### W6: agent-email

- Scope: `services/agent-email/**` and its direct helpers.

### W7: repo-hosting

- Scope: `services/github*`, `services/gitlab.ts`, `services/repo-browse/**`.
  Routes stay in the worker as thin adapters.
- Open PR #2664 (signed webhooks) touches triggers. Avoid its files.

## Rules for every workstream

1. **No behavior change.** No D1 migration, no Durable Object SQLite
   migration, no `wrangler.toml` binding or migration change, no renamed
   Durable Object class or export, no HTTP route or response change, no
   renamed environment variable.
2. **Boundaries.** A package never imports from `apps/*`. The worker imports a
   package only through its public entry points, never a deep `src/` path.
3. **Narrow environment.** The package declares an `XxxEnv` interface with
   only the bindings and variables it reads. The worker's `Env` extends it,
   following `apps/api/src/webhook-trigger-env.ts`. No package function accepts
   the full worker `Env`.
4. **Ports, not imports.** When a module needs something another area owns, it
   declares a small typed interface and the worker passes the implementation
   in. Packages depend only on `shared`, `worker-core`, and where it is natural
   `providers` or `scheduler-core`.
5. **Not `packages/shared`.** Module code does not move into `shared`.
6. **Tests move with the code** when they do not need the worker test pool.
   Nothing is deleted. Report the test file and test case counts before and
   after in the PR.
7. **Docs.** Update path references in rules and docs for files you move, in
   the same PR. Do not edit root `CLAUDE.md`: the coordinator updates the
   repository structure and build order once, at the end.
8. **Stay in scope.** Do not fix unrelated problems. File them as ideas.

## How to work (changes to the usual `/do` flow)

- **Two steps.** Step 1, decouple in place: narrow the environment type, cut
  imports of unrelated areas, define the public surface. This needs nothing
  from W0 and starts immediately. Step 2, lift into the package: starts when
  W0 is on the core branch (announced on the channel).
- **Branch.** Work on the output branch SAM assigned to your task (see the
  table above), created from the core branch. **PR base** is the core branch.
  Open the PR as a **draft** early and keep it a draft.
- **Push after every meaningful step** and keep a short progress note in
  `tasks/active/2026-11-12-modularize-<slug>.md` on your branch. Provider
  usage limits are tight this week, so another agent may have to take over
  from your last push.
- **CI.** Pull-request CI only runs for PRs into `main`. Run it yourself with
  `gh workflow run ci.yml --ref <your-output-branch>` and get it green.
- **Staging.** Do not deploy to staging. The coordinator runs one staging
  verification on the integrated core branch.
- **CodeRabbit.** Skip it on your PR. It runs on the core PR.
- **Do not merge.** When local gates, specialist reviews and CI are green,
  publish the PR URL and full head SHA on the channel and send them to the
  coordinator. Then end your turn and do not complete the task until the
  coordinator says so. The coordinator reviews and merges into the core
  branch. New commits void an approval.
- **Stay current.** Merge the core branch into yours before asking for review.

## Coordinator checklist

- [ ] Core draft PR open
- [ ] W0 merged into core
- [ ] W1 merged into core
- [ ] W2 merged into core
- [ ] W3 merged into core
- [ ] W4 merged into core
- [ ] W5 merged into core
- [ ] W6 merged into core
- [ ] W7 merged into core
- [ ] Root `CLAUDE.md` structure and build order updated; architecture docs synced
- [ ] `main` merged into core, CI green on the core PR
- [ ] One staging deploy of the core branch, full regression of core flows
- [ ] CodeRabbit requested on the core PR
- [ ] Raphaël lifts the draft hold; merge; production deploy monitored

## Acceptance criteria

- [ ] Each of the eight packages builds, lints, typechecks and tests on its own
- [ ] No package imports from `apps/*`; the worker uses public entries only; lint enforces both
- [ ] No package function takes the full worker `Env`
- [ ] Total test case count is not lower than on `b4ef3fba9`
- [ ] No migration, binding, route or Durable Object class change in the diff
- [ ] Staging regression passes on the integrated branch

## Package template

(W0 records the template and decisions here.)
