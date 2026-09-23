# Fix runaway-cost and infinite-loop control paths

**Status:** Active
**Date:** 2026-08-09
**SAM task:** `01KZHZ5SYWMK5YME8WRSRCYDHK`
**Audit idea:** `01KZHYEGJMCWRYRX5CE5PPD6M1`
**Output branch:** `sam/fix-runaway-cost-infinite-rcydhk`

## Objective

Fix every runaway-cost and infinite-loop defect found by the 2026-08-09 Durable Object billing-risk audit in one production-bound PR. Preserve normal request logging, live admin log streaming, task execution, node cleanup, and alarm resumption after emergency controls are re-enabled.

The change must not modify `packages/vm-agent/`.

## Audit findings

1. The API logs requests to `/api/admin/observability/logs/ingest`; the tail worker receives that log and posts it back to the same endpoint. With an admin log subscriber, that creates a self-sustaining feedback loop. A failed or malformed ingest response also leaves the subscriber cache unknown, so the tail worker continues posting open-loop.
2. `NodeLifecycle` unconditionally re-arms every minute while `status='destroying'`. Nothing deletes its storage after the cron owns teardown, so every destroyed node can retain an immortal alarm. The adjacent warm-to-destroying D1 update failure is not retried.
3. `ProjectOrchestrator` leaves zero-task missions active forever and retains `completing` mission rows without a final cleanup path.
4. Several latent loops lack bounded exits: mailbox messages can have no expiry and redelivery does not advance attempts; `DiagnosisRunner` can immediately re-arm; permanently failing node-cleanup candidates remain at the front of every limited query.
5. Operators have no deployment-free master brake for the operational cron sweeps or alarm-bearing Durable Objects.
6. The DO wall-time workflow has never authenticated on scheduled runs, measures latency but not invocation-rate explosions, and cannot detect a dead cron.
7. `cron.completed.failedSweeps` is only logged and never notifies an operator.
8. The API Worker has no explicit CPU cap and there is no sanctioned emergency procedure for cost runaways.

## Root-cause analysis and timeline

- The core NodeLifecycle alarm state machine entered the repository in commit `6be266364a` on 2026-02-24. Its `destroying` state was treated as a retry state but had no terminal observation or age bound.
- The request logger was introduced in commit `62a37dd865` on 2026-02-24. Tail forwarding and subscriber gating evolved through commits `ab20fdbf85` (2026-06-06) and `ded2183b5e` (2026-06-13). Each component was locally sensible, but the ingest route was not modeled as part of the same feedback system.
- Project orchestration and mailbox primitives arrived in commits `a808a08f37` and `6d0c9833d7` on 2026-04-26. Both assumed downstream work would eventually appear or acknowledge; neither encoded a terminal deadline.
- The DO wall-time monitor was added in commit `1b136d0f9` on 2026-07-02. Its job read repository secrets even though the credentials live only in GitHub Environments, causing every one of its 37 scheduled runs to fail before measurement.
- `DiagnosisRunner`'s immediate completed-step retry path was added in commit `b2646b910d` on 2026-08-05.
- A separate 13-hour cron outage on 2026-08-05 led to rule 53, but the monitor still had no positive cron-liveness assertion.
- The billing-risk audit on 2026-08-09 connected these symptoms into one failure class: a control loop can keep scheduling or reselecting work without a terminal exit, candidate escape, rate guard, or working monitor.

## Why existing safeguards missed it

- Tests asserted first-transition behavior but not a second alarm or second sweep after a permanent failure.
- State machines enumerated active transitions without requiring every persisted state to have an observable terminal path and maximum residence time.
- Candidate queries enforced per-sweep limits but did not guarantee that a failing row leaves the next page temporarily.
- Tail-worker tests encoded fail-open subscriber behavior, which is unsafe for a feedback-producing transport.
- The monitor compared P99 wall time only. A million normal-latency invocations therefore looked healthy.
- The monitor's credential boundary was never exercised through the actual scheduled GitHub Environment context.
- `failedSweeps` was an inert log field, not an operational signal.

## Implementation plan

### 1. Break the API/tail-worker feedback loop

- Exclude exactly `/api/admin/observability/logs/ingest` from `http.request` logging while preserving all other routes.
- Treat failed, missing, or malformed ingest subscriber counts as zero and cache that result for the normal cache window.
- Add behavioral regression tests for both ends.

### 2. Terminate NodeLifecycle destruction

- On a `destroying` alarm, read the D1 node row. If it is absent or terminal, delete the alarm and all DO storage.
- Retry the D1 stopped-state handoff when the warm-to-destroying update previously failed.
- Persist a destroying start time and apply an environment-configurable maximum destroying age (24-hour default), after which this nudge-only DO logs and self-cleans.
- Emit `node_lifecycle.destroying_terminal` with the node ID and cleanup reason.
- Prove terminal cleanup and no second re-arm with a two-alarm regression.

### 3. Bound ProjectOrchestrator missions

- Give zero-task missions an environment-configurable grace period (10-minute default), then complete and remove them.
- Give every mission an environment-configurable maximum lifetime, force-completing with a structured reason after that deadline.
- Reconcile and remove persisted `completing` rows.
- Keep alarms armed while either active or completing work remains.

### 4. Harden latent loops

- Apply the existing configurable mailbox TTL default when the caller omits or supplies a falsy TTL; increment attempts on redelivery.
- Add an append-only ProjectData SQLite migration that backfills `expires_at` only where it is NULL.
- Add an environment-configurable minimum delay to the DiagnosisRunner completed-step retry.
- Add an append-only D1 `cleanup_backoff_until` column, exclude backed-off nodes from every node candidate query, and set a configurable backoff after candidate failure.
- Prove with a two-sweep test that a permanently failing node does not occupy the second page.

### 5. Add runtime brakes

- Add KV-backed master switches for the five-minute operational sweep block and alarm-bearing Durable Objects.
- Operational switches deliberately fail open: an absent key or KV read error means enabled so a KV outage does not stop availability work. This differs from the security-sensitive trials switch, which fails closed.
- Cache decisions for no more than 30 seconds. When DO alarms are disabled, re-arm at a configurable safe interval and return without work.
- Gate NodeLifecycle, ProjectData, ProjectOrchestrator, TaskRunner, TrialOrchestrator, DiagnosisRunner, and CredentialSetupSession.
- Add a superadmin read/update API and structured skip logs.
- Test disable, re-enable, and KV-error behavior.

### 6. Repair and extend monitoring

- Run scheduled checks in the production GitHub Environment; expose a `workflow_dispatch` environment choice defaulting to production so a branch can validate against staging.
- Compare recent and baseline invocation rates by script/namespace, with configurable ratio and volume thresholds.
- Query Workers Observability for a recent `cron.completed` event and fail when none exists within a configurable window (3-hour default).
- Dispatch the workflow against staging before merge and require a green conclusion.

### 7. Notify failed sweeps

- Send an in-app notification to every real superadmin when a sweep fails.
- Exclude sentinel/system users and throttle independently per sweep name through KV to at most once per configurable one-hour window.
- Contain notification-delivery failures so `cron.completed` remains the authoritative liveness event.

### 8. Cap CPU and document emergency response

- Set a top-level API Worker `limits.cpu_ms` value of 30,000 ms. Cloudflare documents 30 seconds as the paid Worker and sub-hour Cron Trigger default; the sweep is I/O-heavy and wait time does not consume CPU, so this preserves generous compute headroom while preventing an accidental dashboard increase from becoming an unbounded bill.
- Propagate `[limits]` into generated environment sections and cover it in config-sync tests.
- Document the operational environment variables in code, examples, reference docs, and the env-reference skill.
- Add a rule-32 emergency runbook: KV switches first, Wrangler rollback second, exact credential locations/commands, restoration checks, and a mandatory normal follow-up PR.
- Extend rule 47 so every alarm/control-loop state requires a terminal exit or bounded deadline, and every limited candidate loop requires a two-tick permanent-failure test.

Cloudflare references:

- <https://developers.cloudflare.com/workers/platform/limits/>
- <https://developers.cloudflare.com/workers/wrangler/configuration/>
- <https://developers.cloudflare.com/workers/platform/pricing/>

## Acceptance criteria

- [ ] The ingest route produces no `http.request` event, while all other request logging remains intact.
- [ ] Tail ingest failure or absent subscriber count caches zero; live subscriber delivery still works.
- [ ] Destroying NodeLifecycle storage terminates for absent/terminal D1 nodes, retries a failed handoff, and self-cleans after the configured maximum age.
- [ ] A two-alarm NodeLifecycle regression proves no re-arm after terminal cleanup.
- [ ] Zero-task missions terminalize after grace; maximum-lifetime and completing paths also terminate.
- [ ] Mailbox enqueue always has a finite expiry, existing NULL expiries are backfilled safely, and redelivery advances attempts.
- [ ] DiagnosisRunner never schedules an immediate completed-step retry.
- [ ] Every node-cleanup candidate query respects cleanup backoff; a two-sweep regression proves starvation is prevented.
- [ ] Both runtime switches stop work, re-enabling resumes work, and KV errors leave work enabled.
- [ ] Superadmins can read and update both switches; authorization tests reject non-superadmins.
- [ ] The monitor authenticates through its selected GitHub Environment, detects rate regressions, and detects missing cron completions.
- [ ] Failed sweeps notify only real superadmins and are throttled per sweep name.
- [ ] `[limits] cpu_ms` is top-level and present in generated staging/production sections; Wrangler binding quality remains green.
- [ ] All new durations, thresholds, keys, and limits use `DEFAULT_*` constants and environment overrides.
- [ ] Required documentation, post-mortem, rule 47 process fix, and emergency runbook are synchronized.
- [ ] No files under `packages/vm-agent/` change.
- [ ] Every specified discriminating regression is demonstrated to fail without its corresponding fix.
- [ ] Typecheck, lint, focused tests, complete API/tail/script suites, and repository quality gates pass.
- [ ] Staging deploy, local Playwright smoke, manually dispatched staging DO monitor, and the independent Staging Validator checklist all pass.
- [ ] A single PR is merged only after all gates pass; production deploy matches the merge head SHA and succeeds.
- [ ] Production app, post-deploy `cron.completed`, and a production-environment DO monitor run are verified.

## Independent staging gate

After staging deployment and the implementer's Playwright verification, dispatch the exact user-provided six-item checklist to Staging Validator profile `01KQH75F9JGKG0X27GJZ5767B6`. Merge is prohibited until every item reports PASS. Any failure requires a fix, redeploy, and fresh validator dispatch. Validation-created nodes/workspaces must be removed and staging must finish with zero Hetzner VMs.

## Process correction

This incident class is **a Durable Object alarm or bounded-page control loop with no terminal exit/candidate escape**. The durable prevention is not another local comment. Rule 47 must require:

1. an explicit terminal action or maximum residence time for every persisted alarm state;
2. a failure escape/backoff predicate in every limited candidate query;
3. a regression that executes at least two alarm/sweep ticks under permanent failure; and
4. a positive liveness/rate monitor whose own production credential path is tested.

The change also adds a separate emergency operations rule so responders can safely stop a runaway loop without normal deploy latency, while preserving the requirement for a reviewed follow-up PR.
