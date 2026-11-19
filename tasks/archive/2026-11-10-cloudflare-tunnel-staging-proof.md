# Cloudflare Tunnel staging proof

User authorized proceeding with the staging proof without the blocked Fable
review. Canonical design/research: SAM BYO idea `01KY7M8N1RBC4ZV6ZKSNG878B3`.

- [x] Verify updated staging token by creating a named tunnel.
- [x] Measure same-zone Worker fetch through real DNS at 443 and 8443.
- [x] Check edge TLS for existing nested VM hostname and flat alternative.
- [x] Verify WebSocket idle/binary, streaming, and two HTTP ports through one tunnel.
- [x] Verify fixture auth and connector stop/restart, without public origin listeners.
- [x] Delete owned DNS/routes/Worker/tunnel and retain sanitized evidence.
- [x] Exercise actual VM-agent auth/preview/Git handlers with isolated synthetic dependencies.
- [x] Record integration findings and the next smallest real-node slice.

Scope: first resolve the named-tunnel feasibility gate with an isolated CI
origin in staging. This is not evidence that managed-node integration has shipped.
No production changes or real-user workloads.

Research findings to resolve before a real-node cutover:

- A tunnel reaching the existing VM agent on localhost may pass the Git
  credential endpoint's local-source check. Preserve the private Docker helper
  path while treating tunnel ingress as external; do not expose an unauthenticated
  localhost credential exchange.
- Centralize transport URL choice; multiple existing callers append port 8443.
- Preserve the existing greedy `.vm` Worker route exclusion; test edge TLS.
- Provision/deletion must journal tunnel identity before VM creation and fence
  cleanup by runtime incarnation. Cleanup must include failed provisioning.
- Installer permissions must work for both clean installs and upgrades.

These belong to the canonical BYO integration idea above; this experiment does
not implement or claim them complete.

First run: https://github.com/raphaeltm/simple-agent-manager/actions/runs/42774732470
at `1c084a124`. All transport assertions pass. Both nested and flat hostname
Worker fetches work at 443 and 8443. Direct nested hostname TLS fails; direct flat
TLS passes. Direct tunnel requests arrive on loopback with neither existing relay
header. Dedicated externally-classified listener passed in run
https://github.com/raphaeltm/simple-agent-manager/actions/runs/42775358378 at `e5b416dfa`.
Real preview JWT validation, wrong/missing/expired tokens, two ports, preview
WebSocket, token stripping, public Git rejection, private helper success, and
preview-to-private-helper rejection all passed. See
`experiments/cloudflare-tunnel/FINDINGS.md` for the exact evidence and remaining
managed-node integration. No production feature or managed-node rollout claimed.

## Authorized next phase: implementation and full staging E2E

User requested the complete managed-VM tunnel implementation and thorough live
staging validation, covering all VM-agent communication and port forwarding,
while retaining instant-container compatibility. Plan requested before execution.
The earlier synthetic proof does not satisfy this phase.

- [x] Inventory every browser/API/CLI/MCP-to-agent path and callback; maintain an
      endpoint-to-test matrix with live evidence or explicit failure-path coverage.
- [x] Centralize transport selection for tunnel VMs, legacy VMs, and instant
      containers. Preserve container DO forwarding, timeout and cold-wake/no-wake
      semantics; containers must never acquire tunnel resources.
- [x] Provision one named tunnel per VM incarnation with journaled identity,
      CNAME, connector bootstrap, readiness and credential protection. Node receives
      only its tunnel credential; account API token stays in control plane.
- [x] Implement dedicated externally-classified ingress; preserve private Docker
      Git helper access; block public inbound IPv4/IPv6 before serving requests.
- [x] Cover all URL callers: readiness, management, terminal/ACP/boot-log streams,
      previews, local forwarding, files/attachments/snapshots, Git/worktrees, MCP
      tools/secret execution/build-publication and diagnostics/teardown callers.
- [x] Handle failed provisioning, cancellation, retries, connector restart,
      credential revocation, stale-incarnation cleanup and eventual deletion retries.
- [x] Wire installation settings, permissions, upgrade/clean-install support and
      docs. Preserve existing direct-IP nodes; no IP fallback for tunnel nodes.
- [x] Deploy pinned staging build; actual agent creates/runs site on port 3000
      through normal authenticated UI, inside a real managed devcontainer.
- [x] Browser test assets, routes, queries, POST, redirects, auth/cookies,
      public/private previews, HMR/WebSockets and closing/reopening exposure.
- [x] Test second workspace using the same port on the same VM; test supported
      CLI local forwarding and cross-user authorization with separate identities.
- [x] Exercise agent prompt/stream/steer/cancel, terminal input/resize/reconnect,
      workspace create/rebuild/stop/restart/delete, session sleep/wake/snapshot restore,
      file upload/download, Git/credential refresh, MCP operations and diagnostics.
- [x] Prove origin-IP independence with firewall/listener evidence, tunnel-only
      DNS, explicit transport assertions and route logs. Stop tunnel: access fails
      with no IP fallback; restart: recovery succeeds. Browser traces alone do not
      establish the Worker-to-origin path.
- [x] Negative security tests: missing/invalid/expired/wrong-scope tokens, direct
      tunnel credential/management access, preview-to-helper relay, reserved ports,
      and absence of credentials in target apps or evidence logs.
- [x] Run applicable live user flows on actual instant containers: startup,
      agent interaction, port 3000 previews/WS, terminal, files/Git and sleep/wake/
      cleanup. Verify no tunnel creation and correct routing in mixed deployments.
- [x] Review Go/security/Cloudflare/env/docs changes; resolve blocking findings.
- [x] Retain reproducible tests, screenshots/traces, exact candidate SHA and
      task/session IDs, network-path evidence, and per-scenario results.
- [x] Delete test VMs/containers/DNS/tunnels and verify remote inventory. Compute API absence, all three cleaned journals and authoritative DNS absence passed; independent tunnel inventory returned 401 and is not claimed.

Bound tests to one VM normally, a second only for required isolation/replacement,
and one explicit instant-container fixture. Estimate spend before extended fault
testing. Deliver staging implementation and evidence; production tunnel cutover
is outside this phase. General-purpose raw public TCP/UDP exposure is not part
of the existing HTTP/WebSocket forwarding contract.

## Implementation checkpoint (2026-11-10)

Integrated dedicated Go tunnel ingress, cloud-init connector/firewall, API tunnel
creation and durable cleanup, caller URL consolidation, installer OAuth permission
upgrade and eight typed admin settings. The parent review additionally required
resume safety, transport-switch metadata and delayed external-create reconciliation;
those fixes have focused regression coverage and are in final integration review.

Root lint/typecheck/build pass. The full web test run passed its assertions but
failed on an unrelated toast teardown timer; isolated file rerun passes and SAM idea
`01M729EEJXM1W9QBKFC9QJEVRN` tracks it. This is not a clean root test-suite pass.

This was the pre-deployment checkpoint. The completed managed sweeps and their
remaining checks are recorded below and in
`experiments/cloudflare-tunnel/STAGING-E2E.md`; it is no longer the current state.
All eight generated admin controls subsequently passed actual-definition
desktop/mobile validation, with mutating interactions intercepted.

## Live sweep checkpoint (09:47 UTC)

The initial managed staging deployment is green and both real VM/instant agents ran the port 3000 fixture. See the staging matrix for exact IDs and passed surfaces. Full API15,719 tests /1067 files, CI root Test, SonarCloud, secret scan and Durable Object Workers pass on8a3321ad5. Admin controls have reviewed desktop/mobile evidence posted on PR2615.

Live testing found preview credential leakage, redirect auto-follow and an existing instant PTY spawn conflict. These are fixed with targeted regression coverage and independent review before the final staging candidate. At this initial checkpoint lifecycle/fault/cleanup gates were open and the task was not complete; the final audit below supersedes that status.

## Interim completion audit follow-up

The staging matrix now names boot-log streams/callbacks, worktree CRUD, Git
credential refresh, callback renewal, MCP build/publication, prompt attachments
and managed execution with exact callers and existing test references. The
inventory checkbox was reopened at that interim checkpoint until pending
live/failure-path rows were resolved; broad surface labels are not proof that every caller ran.

Account-credential revocation now has a stateful HTTP401 cleanup regression in
`node-tunnel-cleanup-edge.test.ts`: two unauthorized sweeps retain journal and
resource identity with backoff; restored access cleans only owned resources and
never creates a public-IP/A-record fallback. This does not mutate live shared
credentials or claim a connector-token revocation exercise.

Steering evidence means accepted intent and eventual reply, not interruption
inside a foreground command. Instant snapshot wake independently preserves
nonignored uncommitted text/binary bytes and restores the fixture app; gitignored
fixture files are intentionally outside that preservation assertion.

## Final transport sweep checkpoint (2c7bcf229)

The pinned staging deployment at `2c7bcf2296f7060fc5e01d5af5b92ece9a57a79b`
completed successfully in [run 42797930316](https://github.com/raphaeltm/simple-agent-manager/actions/runs/42797930316).
Worker traffic and both the fresh VM and instant runtime were verified at that
exact version. The later instant terminal credential-environment fix
`90c87b98a` subsequently deployed successfully; see the latest checkpoint below.
Keep the 2c7 fault results distinct from the later candidate's actual reruns.

Final 2c7 live passes cover actual agent port 3000 sites, HTTP/POST/query/302/404,
incremental streaming, text/binary/subprotocol WebSocket with 35-second idle,
application-auth preservation/SAM credential stripping, private/public closure,
CLI HTTP forwarding, terminal 31×97 resize/reattach, exact binary/text transfer,
Git views, diagnostics/log WebSocket, cross-user denials and worktree CRUD.
Creating-phase VM boot-log WebSocket delivered 18 logs and completion. Instant
prompt attachments completed the full presigned-R2→agent digest path, and
sleep/wake preserved exact nonignored uncommitted text/binary bytes. Actual
instant expired JWT returned 401 while a fresh credential returned 200.

Two workspaces on the same final VM passed three alternating exact port 3000
marker reads each and wrong-workspace JWT 401 in both directions while alive.
The temporary second workspace was deleted 200→404; primary remained healthy.
Connector outage produced control 503/preview 530 and independently recovered
both 200 in 57.8 seconds. Reboot verified idle agent/enabled services, new boot ID,
loopback tunnel listener, both firewall families and token permissions. The first
preview before terminal access no longer used the erroneous global container
label; an explicit development-server restart restored preview 200 by 72.5 seconds.
Automatic restart of a user-launched app is not claimed.

Initial-candidate lifecycle evidence remains separately identified: rebuild,
actual VM steer/cancel/follow-up, snapshot sleep/wake on a replacement workspace,
stop/restart and deletion. These are not all repeated final-candidate passes.
Initial reboot failed with an incorrect global discovery label; the final sweep
passed after the fix. The initial VM/host cleanup was independently observed as
API 404, cleanup journal `cleaned`, and zero authoritative DNS records. Direct
Cloudflare tunnel listing was unavailable 401, so only journal-based tunnel
removal is claimed. At that earlier checkpoint final fixtures still required cleanup; final cleanup is recorded below.

Final 2c7 code CI, including root Test, passed; the earlier local web toast teardown
failure is not the result of that final CI run. The specialist review-evidence
gate remains separate and open.

The endpoint inventory and per-scenario evidence filenames are in
[STAGING-E2E.md](../../experiments/cloudflare-tunnel/STAGING-E2E.md).
Unique final fault evidence preserves all initial failures. No public origin-IP
requests were made. The checked browser row establishes HTTP/WebSocket transport,
including the transport used by HMR; it is not a separate framework hot-reload run.
The checked failure/revocation row combines real local boundary tests with live
connector recovery; shared account credentials were never revoked on staging.

## Latest staging checkpoint (90c87b98a, 11:36 UTC)

[Deployment 42803738006](https://github.com/raphaeltm/simple-agent-manager/actions/runs/42803738006)
passed all jobs for `90c87b98a6971d105b9d8db71e2b0b5429c81ba0`. Worker version
`8f14565a-6b97-4cd8-bc25-d8935de61529` serves 100%; both actual VM and instant agent
versions match. The fresh VM actual agent is ready and ran the port 3000 site.
Both runtimes repeated and passed the full core matrix: preview HTTP/WS,
credential isolation, private/public closure, terminal, files/Git views, CLI,
diagnostics and cross-user denial. Streaming first-byte timings were VM 453ms and
instant 440.6ms; each WebSocket remained open for 35 seconds.

Instant normal wake and real-agent follow-up, normal terminal Git helper/control-
plane exchange and `git ls-remote`, 31×97 resize/reattach, and exact text/binary
snapshot preservation pass on 90c. No environment workaround or credential-value
output was used. This closes the scoped instant-terminal environment defect.
Preview/auth/security reruns now pass too, including 440.6ms first streaming byte,
35-second WebSocket and actual expired JWT 401/fresh 200 control. Files/CLI/
diagnostics/cross-user/public-access reruns also passed. Instant worktrees,
authorization boundaries and full prompt attachment/digest passed.

All 90c code CI checks, including root Test, passed. The final completion audit below closes the remaining task validation item; the coordinator records specialist evidence and handles subsequent PR CI/merge gates.

The old 2c7 VM was explicitly deleted at 11:11. Its journal was `cleaned` at
11:16:16.591 and authoritative DNS returned zero records at 11:17. Instant normal-API cleanup then passed (workspace 200→404, node already absent);
the newest VM cleanup subsequently completed, including journal/DNS convergence at 11:36.

The original 2c7 ACP conversation did not recover after reboot. Initial loss of
SessionHost led to dead-runtime reconciliation/task failure at 10:50:19 and
workspace stop at 10:50:28. Manual runtime restart/resume later reached `ready`
using ACP `NewSession`, but the original task/chat stayed failed/stopped and no
durable assistant reply/digest appeared. Importantly, the second deletion was
canonical snapshot/sleep: snapshot verified 11:06:00.871, sleep completed
11:06:15.227, then workspace automatically deleted 11:06:17.708. It is not proof of
unsnapshotted data loss. Generic `vm_agent_error` envelopes included INFO lifecycle
successes; they are not all errors. Exact evidence is preserved in
`vm-reboot-recovery-final-disposition.json`.

Existing idea `01KZM7R67CN19RA29MV6EE0DAA` tracks this separate ACP recovery issue.
Normal UI Retry creates a new task with lineage; runtime restart does not
reactivate failed task ownership. The relevant lifecycle paths are unchanged from
`main`, although no legacy-IP counterfactual was run. This is an explicit P2
lifecycle gap, not a tunnel regression claim or an all-E2E pass. Fresh 90c VM attachment completed agent/independent digest and cleanup at 11:24:48;
normal Git helper/control-plane exchange and remote read passed at 11:25:01.
Actual VM expiry passed at 11:33:29: expired credential 401 and fresh positive
control 200 on the same live app. All owned compute API cleanup completed at 11:33:55; final Cloudflare
journal/DNS convergence passed at 11:36. The fresh fixture's managed
execution job was completed exit 0 at 11:20:45.978 despite a stale active-work
display; it was not live work. No unsupported task resurrection was used. Existing 2c7 tunnel fault proof remains valid for
that candidate; no new destructive fault is required solely for the instant-only
terminal environment change.

## Final follow-up, expiry and cleanup evidence (11:36 UTC)

Fresh 90c VM normal follow-up passed at 11:29:09.951: new durable assistant message
IDs and app health were verified. Agent activity was idle, but `runtimeWorkState`
still reported active from a managed execution job whose authoritative persisted
result was completed exit 0 at 11:20:45.978. No live job was demonstrated and no
cancellation was necessary. Do not claim that the canonical idle-state invariant
is fixed. Separate issue `01M72KJY0QWX6PFAYHN3M6DEM1` tracks the stale indicator;
these execution/reporting paths are unchanged by tunnel work.

VM actual expired JWT 401 plus a fresh valid JWT 200 against the same live app
passed at 11:33:29. All planned ordinary transport scenarios now have passing
local/live evidence within the declared scope. All owned current/historical compute API absence checks passed at 11:33:55;
the instant D1 tombstone confirms deleted/terminated runtime. Final Cloudflare
journal reached `cleaned` at 11:36:09.444. Verification at 11:36:45 confirmed all three owned journals cleaned and all three authoritative DNS lookups empty. Independent tunnel inventory returned 401; no direct inventory-list claim is made. Tiny staged R2 attachments retain their normal retention policy.

The public [sanitized 90c evidence aggregate](../../experiments/cloudflare-tunnel/evidence/staging-90c87b98a.json)
contains 26 scenarios and 115 passed checks. The independent audit compared every
exported check with the private source evidence and found exact agreement;
publication-not-executed and staged-R2 retention remain explicit. No JWT-like
strings were present. Retained 2c7 faults are separate candidate evidence.

## Final task-completion validation

**Task:** this file. **Branch:** `sam/where-did-get-terms-8tbwx9`.
**Reviewed snapshot:** deployed 90c87b98a plus retained 2c7 fault evidence; 2026-11-10 11:36 UTC.
**Verdict: PASS within the declared staging transport scope.**
The audit was read-only; this section records its findings after that audit.

| Check                       | Status                     | Finding                                                                                                                                                                                                                                                             |
| --------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: Research → checklist     | PASS                       | Dedicated external ingress/private helper, caller centralization, hostname routing, incarnation journal/cleanup and installer permissions all have explicit implementation items and substantive changes.                                                           |
| B: Checklist → diff         | PASS                       | Checked implementation items map to tunnel provisioning/cleanup/config, cloud-init/Go ingress, centralized callers, installer and tests. All checklist items have substantive implementation or explicit local/live verification; no unexplained omissions remain.  |
| C: Criteria → verification  | PASS                       | Core cross-boundary transport has live proof; instant Git fix is now verified live; fresh VM attachment/Git and both core matrices pass; both actual expiry cases, compute API absence, all three cleaned Cloudflare journals and authoritative DNS absence passed. |
| D: UI → backend             | PASS                       | Generated eight-setting controls submit revisioned `{name,value}` changes via the existing settings PATCH; backend definitions validate them; tunnel API/cleanup resolvers consume the values. Desktop/mobile evidence exists.                                      |
| E: Multi-resource selection | PASS                       | Runtime/node-class/role discriminators exclude instant/user-owned/deployment nodes; tests cover legacy and tunnel selection. Live two-workspace same-port isolation and cross-workspace JWT denial pass; instant has no tunnel.                                     |
| F: Vertical slice           | PASS within declared scope | Real UI→API→agent→preview, R2→instant agent, host outage/reboot and stateful SQL/Cloudflare boundary tests establish full slices. Positive live publication is intentionally not claimed.                                                                           |

### Resolved findings and explicit boundaries

- **RESOLVED, C: instant terminal Git compatibility.** Planned: “Run applicable
  live user flows on actual instant containers … terminal, files/Git”. The 2c7
  missing workspace environment defect is fixed by 90c87b98a and verified through
  normal terminal Git helper exchange and remote reads, without injected values.
- **RESOLVED, C: fresh VM attachment and private Git completion.** Planned:
  “Exercise agent prompt/stream/steer/cancel … Git/credential refresh”. Fresh 90c
  attachment completed real-agent and independent payload digests, and normal Git
  helper exchange/remote read passed. The earlier rebooted original ACP chat did
  not recover; its separate existing idea and verified snapshot/sleep disposition
  remain explicit. These new passes do not rewrite that historical failure.
- **RESOLVED, C: VM live-expiry negative.** Planned: “Negative security tests:
  missing/invalid/expired/wrong-scope tokens”. Both real-runtime expiry cases now
  pass: the final VM check at 11:33:29 returned 401 for the expired credential and 200
  for a fresh credential on the same live application.
- **RESOLVED, C: owned-resource cleanup.** Planned: “Delete test VMs/containers/
  DNS/tunnels and verify remote inventory”. All current/historical compute API
  absence checks passed; instant termination is confirmed. All three owned
  journals reached `cleaned`, and all three authoritative DNS lists are empty.
  Independent tunnel inventory returned 401, so cleanup proof is the successful
  journals and authoritative DNS absence, not an unperformed inventory listing.
- **Boundary, C/F: authorized MCP publication is local/auth-boundary coverage.**
  Normal VM publication unconditionally builds with Docker, uploads R2 and creates
  a release; no dry-run exists, and instant publication is explicitly unsupported.
  All relevant management routes deny missing/workspace-only tokens live and use
  the tested shared transport. Do not create an external release or invent a new
  dry-run feature merely to turn this into a live positive claim. Keep the gap
  disclosed. Callback age-threshold renewal, shared-account/connector-token
  revocation and a dedicated framework HMR app likewise remain explicit bounded
  coverage substitutions rather than live assertions.

| Acceptance area                | Verification                                                                                                                                                              | Disposition                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Research and implementation    | Every research finding maps to an explicit checklist item and substantive diff; no uncovered finding or unchecked item remains                                            | PASS                                                            |
| Final review accounting        | 90c actual versions and code CI; both core/longtail matrices and actual expiry cases; retained 2c7 faults; independent scoped specialist reviews and this read-only audit | PASS; coordinator owns subsequent PR publication/CI/merge gates |
| Resource cleanup               | All owned compute absent, instant terminated, three journals cleaned, three DNS lists empty                                                                               | PASS within the documented inventory permission limit           |
| Independent lifecycle findings | Original post-reboot ACP continuation and stale execution indicator have separate recorded ideas and precise evidence                                                     | Explicit P2 boundaries; not silently counted as passing         |

No required implementation or unexplained acceptance gap remains within the
stated transport scope. The task is archived after this read-only audit and
confirmed cleanup. This is not a universal full-system E2E pass: authorized live
publication, framework-specific HMR, live credential revocation/age renewal and
original ACP continuation retain the qualifications above. Production cutover is
not claimed.
