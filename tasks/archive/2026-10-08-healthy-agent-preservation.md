# Preserve healthy agents and failed-task snapshots

Source: idea 01M4DR5SFBBZZ99SFVKYD8ZD0X; SAM task 01M4DV3CTCZBNN09E2CMK37W66.

## Problem

Node-wide 8h prompt deadlines kill productive tasks before the control-plane absolute ceiling. Error activity callbacks also remove failed-task snapshot ownership, allowing the orphan sweep to destroy unpushed work during capture.

## Research

- server.go selects prompt timeout once from boot TASK_ID; agent_ws.go already resolves per-session task context.
- SessionHost newPromptContext and watchPromptTimeout enforce the duration deadline.
- sleep-preserved-task-status.ts requires a resumable agent even during a claimed preservation snapshot; both VM and Instant reapers consume it.
- Existing snapshot in-flight age and attempt limits must still release stale/exhausted captures.
- Existing failed-task integration tests provide real SQLite and sleep lifecycle with replaceable VM capture boundary, suitable for a controlled orphan-sweep midpoint.

## Checklist

- [x] Remove task prompt duration kills using session-scoped task identity; retain control-plane inactivity classification and absolute ceiling.
- [x] Protect bounded failure-preservation captures after agent error while retaining abandoned-workspace cleanup.
- [x] Exercise real prompt execution/timeout and orphan-sweep ordering; prove guards by mutation.
- [x] Assess cheap safe failure-cause improvement; document outcome.
- [x] Update affected configuration documentation.
- [x] Run local quality checks and independent specialist reviews.
- [x] Coordinate staging lease, refresh binary, provision and verify real VM, clean resources.
- [ ] PR, CI, best-effort CodeRabbit wait, merge and production deployment evidence.
- [ ] Append evidence to idea, complete only after both fixes deploy; publish MERGED/DONE and cancel subscription.

## Acceptance

Healthy task prompt progress survives the previous duration timeout; normal cancellation and API absolute ceiling remain operative. A failed-task snapshot completes despite an error callback and intervening orphan sweep. Stale/exhausted captures remain reclaimable. Regression tests fail when each protection is removed.

## Rules

VM rules 27/54; root rules 62/67; /do review and staging gates. Shared channel reliability-wave-1008 kickoff staging lease and migration claims. No migration planned.

## Implementation evidence

- TaskManaged is bound per SessionHost from session task context (legacy boot context only for its own workspace). Task-managed prompts skip duration deadlines; upstream cancellation/deadlines remain honored. Removed obsolete ACP_TASK_PROMPT_TIMEOUT.
- Both reapers bind existing SESSION_SLEEP_IN_FLIGHT_MAX_AGE_MS cutoff and preserve an exact project/chat/workspace preparing/stopping claim after agent error. No migration or widening of resumable agent statuses.
- Real HandlePrompt test emits transcript progress for 9 simulated hours; mutation fails at8h with fatal_error. Scope test distinguishes sibling unmanaged session. Caller deadline remains fatal.
- Real orphan sweep runs while hibernate boundary is deferred; after error flip it preserves running workspace, then capture settles sleeping with WIP artifact. Guard removal stops workspace at midpoint. Initial fixture lacked node_class; mutation revealed exclusion and fixture was corrected to managed.
- Separate mutation checks prove project/workspace/claim/age/status restrictions.
- Typed context deadline and EOF errors now report stable deadline/agent_crash causes without exposing raw provider error text.
- Typecheck19 tasks passed. Go ACP/config/server suites passed. Affected API suites77 tests passed plus cleanup SQL fixture suites. Full quality checks in progress.

Review findings addressed: canonical environment reference retired old knob; Instant real reaper midpoint added; chat/sleeping-state and stopping clock/fallback mutation controls all red when removed. Local specialist reviews (Go, Cloudflare, environment, constitution, test, task completion, docs) PASS. Full lint13/13 and build9/9 passed. Full test run capped at two workers after resource-driven import/worker startup timeouts; still running.

## Final validation and staging evidence

Full bounded root suite:21/21 tasks; API827 files/11,631 tests and web336 files/4,023 tests. Full lint13/13, typecheck19/19, build9/9; Go ACP/config/server suites pass. Initial unconstrained runs exhausted local workers/import timeouts; bounded run changed no assertions.

Staging workflow https://github.com/raphaeltm/simple-agent-manager/actions/runs/37789938518 passed, including automated smoke. Lease channel sequence30, release42. Zero existing nodes before deployment. One fresh Hetzner cx23 (2CPU/4GB), node01M4DYG2HZTEWJGDSSGDSXNRNN, immutable agent release189adec93ca6fc0339a2d73a996889bef6ec9a0b, heartbeat14:28:20.898Z, readiness14:29:55.644Z. Allocation-to-observed-heartbeat146.659s; system-info host uptime confirms heartbeat within two minutes of actual VM boot. HTTPS terminal and Claude task worked.

Fresh chatf2dd439b-bdf1-441d-8a74-5fc6108e0fe9 in project01M4B1N63Q5XE39D9SCQHSNDBH created untracked healthy-agent-unpushed.txt. Controlled failure via task status API then normal workspace sleep completed14:36:07.817Z with a full available snapshot. Downloaded WIP bundle677bytes, SHA256692d4a6bcd10df277036f70a23227d27ad1f6761bafc9241b76c0bb2a87a49bb matched manifest; restored exact HEALTHY_AGENT_PRESERVATION_20261008 sentinel into a local base clone. Browser showed Sleeping/Failed Retryable; dashboard/projects/settings/chat navigation produced no page errors. No nine-hour live wait or live error/reaper race claimed: those are deterministic real-path tests above. Harness refused the probe's bare sleep command; the test used authenticated task failure rather than bypassing that guard.

Workspace01M4DYRAGE7T9VY3BKDPDDEZ21 and node deleted through API. D1 confirmed no test workspace and zero active staging nodes before release. PR/CI/review/production tracking continues in PR and SAM task; idea remains incomplete until production deployment.

## Post-mortem

The8h task override originated in7ccf04622/#1828 and was chosen at node boot. Failed-task preservation23b477af6/#2145 required a resumable agent even while a capture owned the workspace. Independent lifecycle authorities therefore disagreed during long prompts and error callbacks. Configuration-only timeout tests and non-interleaved snapshot tests missed both behaviors. Existing rule62 is sufficient standing guidance; this change adds real prompt and real reaper midpoint tests plus guard-removal evidence rather than more instruction text.
