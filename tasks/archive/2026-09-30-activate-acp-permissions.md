# Activate ACP permission interactions

## Problem

PR #2202 proves the permission request and answer path on staging, but the checked-in Worker flag still disables request creation. The activation needs a reviewed release, an operator rollback, and explicit evidence about which pinned agents actually emit requests.

## Research

- `apps/api/wrangler.toml` and the shared fallback both set `ACP_INTERACTIONS_ENABLED=false`; GitHub staging and production Environment variables have no override as of 2026-09-30.
- The deployed staging and production Worker settings both report `false` before this change.
- `codex-acp` 1.13.1 receives SAM's `agent-full-access` mode and sends `approvalPolicy=never` and `dangerFullAccess` on every turn. A real process completed a shell turn without a permission request.
- Claude wrapper permission emission needs a pinned process or staged account test; transport fixtures from #2202 are not provider emission.
- Older vm-agent code selected the first permission option. New VM task placement uses `VM_AGENT_REQUIRED_VERSION`; active sessions on older nodes need an explicit rollout disposition.

## Checklist

- [x] Keep permission creation disabled by default and require an explicit `true` deployment override after the release hold clears; `false` remains the rollback value.
- [x] Update the public configuration reference and focused flag tests.
- [x] Verify pinned wrapper behavior and old-node compatibility; record actual account versus fixture evidence.
- [x] Run focused tests, specialist reviews, CI, and a coordinated staging candidate for the reconciled head. Record the VM permission pass and the Instant/form gaps separately.
- [x] Record exact release head, deployed staging value, cleanup, rollback plan and owner, and limitations in draft PR #2204 for parent review.

## Acceptance criteria

- A Worker with an explicit `ACP_INTERACTIONS_ENABLED=true` override advertises the proven permission bridge to version-compatible VM and Instant runtimes; a fresh deployment without the override does not.
- Setting `ACP_INTERACTIONS_ENABLED=false` disables new requests without preventing existing pending requests from being answered or read.
- Forms require their own opt-in and are advertised only for conversations; URL elicitation remains unavailable.
- The follow-up is not merged or activated in production by this task agent.

## Evidence in progress

- Rebased on main merge `86e6c5b75439cb2f495cc87f3b245fcd04d6c3f2` after #2202 merged at 16:16:23Z.
- No staging or production GitHub Environment override for `ACP_INTERACTIONS_ENABLED`; both deployed Workers reported `false` before this follow-up.
- Local `codex-acp` 1.13.1 with SAM's exact mode/config completed one real account shell turn (`end_turn`), emitted 16 `session/update` notifications, and emitted zero `session/request_permission` calls.
- Pinned `claude-agent-acp` 0.81.2 source sends `client.requestPermission` from `canUseTool` with the tool signal. A real staging Claude Instant account using explicit `permissionMode=default` emitted permission requests for MCP `get_instructions` and a harmless Python command. The browser rendered their exact options, and rejecting through the UI reached `delivery_confirmed` for both. The first staging session's request was cancelled when its turn ended before answer; it is not counted as a successful answer.
- Candidate `b9b96b579edd0940810295397e9719d8ea2804f8` deployed through staging workflow `36747159371`. The deploy job passed; its smoke job initially timed out waiting for `networkidle` on the settings page, then passed on one failed-job rerun. The effective `sam-api-staging` Worker binding reported `ACP_INTERACTIONS_ENABLED=true` after deploy.
- Draft PR #2204 originally contained the staged runtime candidate plus evidence commits; the later reconciliation also changed flag tests and kept creation disabled by default. The release hold controls readiness, merge, and production activation.
- The explicit staging profile `01M3SMFPP7SQW5VAPMNVY9FJD9` was created with `agentType=claude-code`, `runtime=cf-container`, and `permissionMode=default`; its response echoed those values. The first session was `a6024e71-fe31-4e5e-96bc-925998943434` in workspace `01M3SMGBC3B5PMVP46E4N8WK87` and had one cancelled, unanswered request. The second was `108c309f-4642-4061-a661-8a9ad42bbd34` in workspace `01M3SN15CRA0R2SACEYDWPXKGG`. Its MCP request `9b408eac-eda5-4bc4-8473-9c7749b783e3` and harmless Python request `ad8076b4-0126-42f3-921d-068908e84893` each offered the exact `reject`/`reject_once` option; browser **No** answers reached `delivery_confirmed` with `deliveryState=confirmed`, and the card showed “Delivered to agent.” This is behavioral evidence of the effective permission path; there is no separate persisted runtime-mode readback after profile cleanup.
- Both staging chat sessions were stopped, both agent sessions are `stopped`, both workspaces are `deleted` in D1, and the temporary profile returns 404. B released staging to compatibility agent `01M3REWHQEVNFNB5CC5G5KJ5WX`; the earlier C1 handoff was superseded. C1 `01M3SGWNFG7NGAY788GA465P25` waits for compatibility release and parent review of its exact candidate.
- Focused API tests passed 39/39, Worker store tests 8/8, isolated API suite 795 files/11,086 tests, root lint 13/13 packages, typecheck 19/19, and build 9/9. The first concurrent root aggregate test run had an API package failure under load; the isolated API rerun passed. Specialist reviews passed for staging readiness.
- Before the 2026-10-01 deletion, production base deploy had completed with `ACP_INTERACTIONS_ENABLED=false`. Old node `01M3RBQNPZS29SA21HBT4V7KVT` ran vm-agent `e9820d9f9f6beec1bfa99c654d97f41921aaa4e7` with one Claude and four Codex sessions. The Claude task `01M3RBQBHV39B9SHDC4BWBR16B` completed at 08:26:39Z (PR #2198); its chat summary last message was 08:26:55Z and recent resource-history chunks showed zero tool spans. Its D1 agent session `01M3RC2TZ8M7PH05137VMWGTKM` was then `running`, which did not prove an in-flight turn. Canonical live `/state` required owner authentication; this task's MCP token received 401.
- Before deletion, the completed Claude workspace `01M3RBZ3RX4JN084KMNM21A5MT` was live. Its snapshot was `degraded/home-skipped`, with a 257,916,024-byte WIP artifact, no home artifact, and 24 entries skipped for budget (72,421,962 bytes). Automatic sleep reached nine attempts; its state was observed as `failed` and later `scheduled`. A direct sleep was not full-state-safe: the final-capture path allowed a degraded snapshot to release compute. The owner-authenticated agent-session stop was the narrow supported way to halt that old Claude process while keeping its workspace files. Full resumable migration would have needed a larger snapshot budget and a strict final-generation completeness gate before teardown.

## Release and rollback — refreshed 2026-10-02

This is a draft activation candidate, not a production activation. PR #2206 already
merged the form bridge with both flags defaulting off. PR #2208 merged at
10:42:57 UTC and requires a complete final snapshot before future VM or Instant
teardown; it also rejects direct agent-session creation on incompatible existing
VMs. Neither change recovered the deleted old node's missing home artifact.

Current candidate validation is distinct from the historical permission-only
staging run. Candidate `5935e8219` deployed through
[staging run 37065863311](https://github.com/raphaeltm/simple-agent-manager/actions/runs/37065863311),
including its health check. The API runtime-config test passed 6/6; the Worker form,
permission and vertical-slice tests passed 14/14 after building the required
workspace packages. The vertical-slice test now creates through the authenticated
callback, turns both flags off, reads pending detail through creator-authenticated
browser routes, and answers through Cloudflare before a mocked VM delivery
receipt. This does not prove a pinned agent's same-turn continuation. Focused
Cloudflare/security, test/task-completion, environment, constitution and docs
reviews found no blocking code issue; live provider proof remains outstanding.

Read-only production D1 at approximately 20:45 UTC on 2026-10-02 confirms node
`01M3RBQNPZS29SA21HBT4V7KVT` is `deleted` with runtime termination at
2026-10-01T05:16:52.465Z, all its workspace rows are `deleted`, and the only
retained snapshot for `01M3RBZ3RX4JN084KMNM21A5MT` remains
`degraded/home-skipped` with a WIP and manifest artifact but no home artifact.
Its snapshot expires 2026-10-07T09:47:49.687Z. This is a concrete recovery
risk for that old session; do not claim its home or unpublished work was
recovered. Owner review of the retained partial artifacts and recovery options
is separate from activating new compatible sessions. No operation on the
old node/workspace is part of this release.

The deployed production Worker currently reports
`ACP_INTERACTIONS_ENABLED=false`, `ACP_INTERACTION_FORMS_ENABLED=false`, and
`VM_AGENT_REQUIRED_VERSION=7a9782c90ee281a79642fa501ab41be994d932c1`
(the #2208 merge). Two running production VMs report that version. Another
running VM reports `989bf7bb6a45998d09d56bd2051d5c786a5e0800` and has
three active workspaces and three running agent sessions. Two further running
VMs have no active workspaces and report an older or absent version. The
#2208 direct-session gate and version-aware placement protect new VM admission;
the Worker builds the interaction contract only on a new agent-session start
request and the VM host captures it at start. Flipping the Worker flags does
not change an already-running host or active turn. Existing sessions on older
builds are not upgraded in place. Read-only
production state and an unchanged deployed flag are evidence of the gate,
not proof of a live permission/form continuation.

For any further staging matrix, the parent assigns a serialized slot. Use one reviewed candidate
and one bounded matrix: first read back effective `false/false`; enable only
`ACP_INTERACTIONS_ENABLED=true` and verify a real Claude permission request,
answer and continuation on Instant and one compatible VM; leave forms false.
Then enable `ACP_INTERACTION_FORMS_ENABLED=true` and verify a real emitted
conversation form, human answer and same-turn continuation on each runtime
where a pinned provider actually emits forms. A synthetic callback or adapter
fixture proves the transport contract only. Test a task-mode form denial and
unsupported form/schema cancellation without claiming provider emission. Keep
URL elicitation outside this PR. If no pinned provider emits a real form and
continues after the human answer, leave forms disabled for release and record
the live case as unverified. Reuse one staging VM if possible,
never exceed the parent-approved cost cap, and remove staging compute after
verification. A staging deploy or provisioning attempt requires parent slot
assignment first.

For release after parent review, inspect staging and production GitHub
Environment overrides for both flags, deploy the exact reviewed candidate,
and read back the Cloudflare Worker bindings after each step. First opt in only
permissions. Then independently opt in conversation forms after the live
matrix passes. The flags can be rolled back separately: set the form override
`false` while leaving permissions `true`, or set the permission override
`false` to stop both new permission and form creation. Redeploy and read back
each effective binding. A flag change does not revoke a pending request:
Cloudflare InteractionStore still serves snapshot/detail and accepts a valid
human answer until its deadline, then the runtime delivery path confirms or
records interruption. Do not use a direct browser-to-VM answer path.

Provider evidence remains limited: a real staged Claude Instant account under
`permissionMode=default` emitted permission requests, and browser rejection
reached `delivery_confirmed` on the historical candidate. A real pinned
`codex-acp` 1.13.1 shell turn under
SAM's `agent-full-access` emitted zero permission requests; that observation
does not establish Codex permission support or impossibility. Existing form
unit/Worker/Go tests use synthetic ACP requests and a mocked runtime boundary.
They establish validation, persistence, reply shape and generation fencing,
but do not establish that pinned Claude or Codex emits a form or continues
from a real human answer. The parent must record this distinction in live
verification and release review.

### Reconciled-head staging result — 2026-10-02

The parent assigned one serialized staging slot. Before deployment, staging
Worker bindings were `false/false`; the checked-in defaults are still
`false/false`. An explicit staging Environment override enabled only
`ACP_INTERACTIONS_ENABLED=true`. Deployment run `37065863311` completed
successfully at exact head `5935e8219`. Cloudflare Worker readback showed
permissions `true`, forms `false`, and
`VM_AGENT_REQUIRED_VERSION=7a9782c90ee281a79642fa501ab41be994d932c1`.
The parent removed the temporary staging permission override and ran
[rollback deployment 37069402539](https://github.com/raphaeltm/simple-agent-manager/actions/runs/37069402539)
at exact code head `5935e8219`. Its deploy and smoke jobs passed. The staging
GitHub Environment has no override for either flag, and a fresh Cloudflare
Worker readback reports `false/false`; `/health` returned 200. Production
bindings were not changed. The PR head `b15c59c38` adds only this live-evidence
runbook after the staged code head.

A fresh Claude Instant conversation with `permissionMode=default` emitted a real
MCP `get_instructions` permission. The parent saw the card in a browser but
submitted no answer: its SessionHost stopped at 21:33:40.720 UTC, the
Cloudflare interaction became `cancelled/interrupted` at 21:33:41, and the
workspace entered checkpoint recovery. It remained in recovery until the
bounded fixture was stopped. This proves emission and authoritative storage,
not accepted-answer continuation on Instant. The specific host-stop cause was
not established. The session stop returned `workspaceDeleted=true`, and the
temporary Instant profile was deleted.

A fresh compatible Claude VM (`agent_version` exactly the required version)
emitted two real permission requests: MCP `get_instructions` and
`python3 -c 'print("ACP_PERMISSION_CONTINUATION_CANARY")'`. The parent used the
browser, including reload, to choose `allow-once` for each. Before cleanup,
Cloudflare recorded both interactions as `delivery_confirmed` with
`deliveryState=confirmed`: MCP `get_instructions`
`71af54d1-9137-447f-a5be-de43d6152f55` was answered at
21:47:34.290 UTC; Python `29366d4c-d409-4dde-9bf0-dcbb9b00116a` was
answered at 21:48:23.922 UTC. The same turn ran the exact command. Its tool
output containing `ACP_PERMISSION_CONTINUATION_CANARY` was stored at
21:48:24.888 UTC, the final assistant text ended with
“ACP permission continuation complete.” at 21:48:26.442 UTC, and the
pre-stop session-state read showed `idle` / `completed` at 21:48:26.492 UTC.
The parent captured pending, delivered-answer, and intermediate continuation
screenshots before stop; the final stdout screenshot was taken after stop and
must be labelled that way. The operator stopped the idle chat at
21:49:20.154 UTC to clean up; the later UI Stopped/Failed/Retryable
banner and task `cancelled` / “Archived by user” reflect that cleanup, not an
earlier failed permission continuation. The staging VM node and temporary
profile were deleted at 21:52 UTC; the node list was empty, and D1 had no node
or workspace row. No staging VM was left running.

Conversation forms were never enabled in this slot. The exact pinned
`claude-agent-acp@0.81.2` adapter has `AskUserQuestion` and MCP form builders,
and pinned `codex-acp@1.13.1` has a `request_user_input` builder; the checked-in
fixture verifier ties those source/builders to bounded schema examples. That
is provider capability evidence, not a live form emission or human-answer
continuation. Keep `ACP_INTERACTION_FORMS_ENABLED=false` for release until a
fresh compatible conversation under forms opt-in demonstrates that path on
VM and Instant. The current Instant permission interruption and no live form
answer are concrete remaining readiness gaps; do not present VM permission
success as a complete permission-and-form matrix.

## References

- Approved v2 idea `01M3P2E0JJNQRXX020P65ZRKEJ`
- Base PR #2202, exact head `aecaf205f405442eaabfbb5b98503e5901219128`
- `.claude/rules/70-flag-flips-must-verify-the-deployed-value.md`


## Parent integration evidence — 2026-10-03

The original child-task draft/no-deploy constraints above describe that handoff.
The parent owns the subsequently authorized readiness, merge and production
release. Integrated PR #2217 includes these changes; the current evidence and
remaining release steps are in `scripts/diagnostics/acp-runtime-distribution.md`.
Full integrated CI `37121769606` and staged head `e27c4d092` passed. Live VM
permissions, form and both URL completion orders passed; Instant Claude
permissions, Codex form/URL same-turn continuation, actual candidate executable
selection and fresh-stock GPT-5.5 rollback now have distinct live evidence.
Timeout/interruption and unsupported-model attempts remain explicitly excluded
from successful continuation claims. No new provider login or token custody was
added. Final rollback and release disposition remain parent-owned.
