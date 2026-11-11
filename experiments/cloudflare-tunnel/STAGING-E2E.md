# Managed VM tunnel staging verification

Status, 2026-11-10 11:36 UTC: `90c87b98a` is successfully deployed; both actual
runtimes passed the repeated core sweep. Normal instant terminal Git exchange is
fixed and verified. Fresh VM and instant prompt attachments completed agent and
independent digest checks; native Git helper exchange and remote reads passed.
The instant fixture is deleted. VM actual-token-expiry verification and all owned compute API deletion checks
also passed. All three owned Cloudflare journals are cleaned and authoritative DNS lists are empty. The scoped completion audit is **PASS**, with the lifecycle and coverage boundaries below retained.

The earlier `2c7bcf229` sweep established the core VM/instant matrix, same-VM
isolation, connector outage and tunnel/preview reboot recovery. Original ACP chat
continuation after reboot did not recover; this is a separately tracked lifecycle
gap, not a full-system reboot pass. No production tunnel cutover is authorized.

## Candidate and evidence boundaries

| Stage                    | Exact candidate / deployment                                                                                                                                                                | Meaning                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feasibility experiment   | See [FINDINGS.md](FINDINGS.md)                                                                                                                                                              | Isolated CI origin and real agent handlers with synthetic dependencies; not managed-node E2E.                                                                                                                                                                                                              |
| Initial managed sweep    | `d38788564d71f0956d7046407e3a300e91f09dd5`; [run 42788029854](https://github.com/raphaeltm/simple-agent-manager/actions/runs/42788029854); agent `07b7a279b10d80981fb8b37393cfcffc6801f38c` | Established lifecycle coverage and found real preview, PTY and reboot defects. Its successes are not rerun claims for the later candidate.                                                                                                                                                                 |
| Final transport sweep    | `2c7bcf2296f7060fc5e01d5af5b92ece9a57a79b`; [run 42797930316](https://github.com/raphaeltm/simple-agent-manager/actions/runs/42797930316), successful                                       | Worker traffic 100%; fresh VM and instant runtime both reported this exact agent version. Retained same-VM isolation, connector outage and reboot proof refers to this candidate; core surfaces were subsequently repeated on 90c.                                                                         |
| Latest staging candidate | `90c87b98a6971d105b9d8db71e2b0b5429c81ba0`; [run 42803738006](https://github.com/raphaeltm/simple-agent-manager/actions/runs/42803738006), all jobs passed                                  | Worker version `8f14565a-6b97-4cd8-bc25-d8935de61529` serves 100%; both actual agent versions verified. Both actual runtimes passed core checks, native Git exchange and full prompt attachments. Both real-expiry checks, compute API cleanup and all three Cloudflare journal/DNS cleanup checks passed. |

Tests use the owned staging Artifact project on `sammy.party`, normally one small
VM and one bounded instant container. Two-workspace isolation uses the same VM;
the temporary second workspace is deleted immediately. A real UI agent builds,
runs and Git-pushes the HTTP/WebSocket port 3000 fixture. No public origin-IP request
is used. [Reusable helpers](../../scripts/e2e/cloudflare-tunnel-helpers.mjs) reject
literal-IP and out-of-domain destinations. Authentication state, tokens and raw
terminal output remain private.

Private `.codex/tmp/tunnel-e2e/fixture.json` records exact project/profile/session/
workspace/node IDs and archived VM history. `final-deployment-evidence.json` records
the 2c7 deployment/runtime versions; `final-90c-deployment-evidence.json` records
the latest deployment and both actual runtime versions. The initial JSON evidence is retained
separately with a hash manifest. Final fault/isolation runs have unique timestamped
filenames; earlier failures are preserved. These private files are execution
artifacts, not repository fixtures or public download links.

The committed [sanitized 90c evidence aggregate](evidence/staging-90c87b98a.json)
contains 26 runtime/scenario rows and 115 passed checks. Every exported check was
compared with its private source artifact; all match. It explicitly preserves
unexecuted authorized publication and staged-R2 retention qualifications. The
aggregate covers the 90c core/long-tail sweep; retained 2c7 fault evidence is
separately identified below.

## Latest 90c87b98a verification

- Deployment completed successfully, Worker traffic is 100%, and both actual
  agent versions match the full SHA. Fresh UI-started VM agent built and ran the
  site; host listener/firewall/token-permission checks passed again.
- **Both runtimes repeated the full core sweep:** HTML/assets, POST/query,
  302/404, incremental streaming (VM 453ms; instant 440.6ms first byte), text/binary/
  subprotocol WebSocket with 35-second idle, preview credential isolation,
  private→public→private access, CLI HTTP forwarding, terminal 31×97 resize/
  reattach, exact files/Git views, diagnostics/log WebSocket and cross-user denial.
- Instant normal wake/follow-up and exact text/binary snapshot preservation pass.
  The scoped terminal environment fix now supports normal Git helper/control-plane
  exchange and `git ls-remote`, without environment injection. Worktree CRUD,
  management/helper authorization boundaries and real expired JWT 401 with fresh 200
  control also pass. Its real R2 prompt attachment completed undisclosed payload
  hashing, independent digest verification and copy cleanup.
- Fresh VM full R2 attachment/digest/copy-cleanup passed at 11:24:48; native Git
  helper/control-plane exchange and remote read passed at 11:25:01. Evidence:
  `vm-longtail-attachment-evidence.json` and `vm-longtail-git-refresh-evidence.json`.
  The fresh fixture's managed execution job was already completed with exit 0 at
  11:20:45.978; a stale active-work display was not evidence of live execution.
- Instant normal-API cleanup passed: workspace delete 200 then 404, node already
  absent. `instant-final-cleanup-evidence.json` retains proof. VM worktree CRUD/branch cleanup and all nine management/helper/ownership
  boundaries also passed by 11:26:05. Actual VM expiry passed at 11:33:29:
  the genuinely expired credential returned 401 and a fresh credential returned 200
  against the same live app. Final compute API cleanup completed at 11:33:55: every owned current/historical
  VM/workspace returned 404. The instant D1 tombstone has confirmed runtime
  termination and no active compute. The final Cloudflare journal reached `cleaned` at 11:36:09.444; all three owned journals are cleaned and all three authoritative DNS lists are empty. Independent tunnel inventory remains unavailable (401), so no direct inventory-list assertion is made.
- Existing 2c7 isolation/outage/reboot evidence remains the fault proof. 90c changes
  instant terminal environment, leaving the managed path unchanged; no extra
  destructive fault is required solely for that fix.

The matrix records the latest live result, with retained earlier-candidate proof
identified explicitly. Per-surface private filenames hold the latest rerun; use
timestamps and deployment manifests to identify the candidate. Unique fault
records preserve the original 2c7 runs.

## Live surface matrix

| Surface                      | Live result                 | Evidence / qualification                                                                                                                                                                                                                                                         |
| ---------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provisioning and callbacks   | **PASS**                    | Fresh VM ready/heartbeat; exact runtime version; tunnel transport/incarnation journal; authoritative proxied CNAME only. Instant reports `cf-container` and no tunnel ID.                                                                                                        |
| Actual agent site            | **PASS**                    | UI-started agents built/reran the fixture, exposed port 3000 and used ordinary Git authentication. A browser URL alone is not treated as proof of the Worker-to-VM path.                                                                                                         |
| Boot-log WebSocket           | **PASS, VM**                | On 2c7, connected while workspace was creating; 18 log frames and one completion frame, including clone/devcontainer/Git setup/ready steps (`vm-longtail-bootlog-evidence.json`).                                                                                                |
| HTTP preview                 | **PASS, both**              | HTML, exact asset bytes, POST/query, preserved 302,404 and incremental streaming; final `vm-preview-evidence.json` / `instant-preview-evidence.json`.                                                                                                                            |
| Preview WebSocket            | **PASS, both**              | Text/binary echo, requested subprotocol and a 35-second idle connection. This verifies the transport used by HMR; no separate Vite/Next hot-reload application was run.                                                                                                          |
| Preview credential isolation | **PASS, both**              | Application Bearer/cookie preserved; SAM Bearer/cookies stripped; app authentication cannot bypass private preview. Real-handler regression covers HTTP and WebSocket authentication.                                                                                            |
| Private/public access        | **PASS, both**              | Anonymous private denial, normal public toggle, then closure denies access again.                                                                                                                                                                                                |
| CLI forwarding               | **PASS, both**              | Normal CLI forwards assets and POST/query through the authenticated Worker. The current CLI HTTP mode explicitly does not support WebSocket forwarding.                                                                                                                          |
| Terminal transport           | **PASS, both**              | Create/input, 31×97 resize and disconnect/reattach preserving shell state. Instant Git credential environment was a distinct 2c7 defect, subsequently fixed and verified live on 90c.                                                                                            |
| Files and Git views          | **PASS, both**              | Exact29-byte binary upload/download, text view/raw, listing/find, Git status and marker-bearing diff.                                                                                                                                                                            |
| Diagnostics                  | **PASS, both**              | Node system information, events, logs and log WebSocket.                                                                                                                                                                                                                         |
| Cross-user access            | **PASS, both**              | Separate identity denied workspace, terminal-token, preview, files and node diagnostics.                                                                                                                                                                                         |
| Worktree CRUD                | **PASS, both**              | Authenticated list/create/read/remove; temporary branch removed. VM test ran after reboot.                                                                                                                                                                                       |
| Security negatives           | **PASS for executed cases** | Missing/invalid/wrong-port tokens 401; external Git helper 401. Live two-workspace JWT rejection is below. Instant reserved listener 403 and real expired token 401 with fresh-token 200 control passed. VM actual expiry 401 with fresh 200 control subsequently passed on 90c. |
| Prompt attachments           | **PASS, both on 90c**       | Both fresh 90c runtimes completed presigned R2 upload → normal prompt → agent computed the undisclosed 66-byte payload hash → independent workspace digest → copy removal. The earlier post-reboot VM continuity failure is retained separately below.                           |
| Snapshot preservation        | **PASS, instant**           | Sleep/wake restored exact nonignored uncommitted 32-byte text and 8-byte binary files; both remained in Git status. Ignored `.sam-e2e/` files are intentionally outside this assertion.                                                                                          |
| Admin controls               | **PASS, generated UI**      | Eight definitions, actual deployed responses and 27 reviewed desktop/mobile captures; normal, empty, invalid, long-content and error states. Mutating save/error interactions were intercepted. [Committed screenshot evidence](evidence/admin-settings/README.md).              |

### Same-VM isolation and host faults

- **Isolation passed in 53.1 seconds.** One additional 0.25-vCPU/0.5-GB workspace was
  pinned to the existing VM. Three alternating reads per workspace returned its
  exact port 3000 asset marker. Primary-token-on-second and second-token-on-primary
  both returned 401 while both applications were alive. Delete returned 200 and the
  second workspace then returned 404; primary remained running and healthy.
  Evidence: `vm-final-isolation-2026-11-10T10-43-48.473Z-e4a19dbf-evidence.json`.
- **Host protection passed.** Both services active; connector user
  `sam-cloudflared`; tunnel listener exactly `127.0.0.1:8444`, management port8443;
  IPv4 and IPv6 INPUT chains deny public agent ports and SSH while preserving
  loopback/Docker helper paths. Connector token permissions are400 with the
  dedicated owner. Only permissions were read, never token contents.
- **Connector outage passed.** An independent 45-second restore timer, verified
  active with one-second accuracy, preceded a three-second delayed connector stop.
  Control returned 503 and preview 530 throughout the observed outage. Both
  recovered200 automatically at 57.8 seconds from test start, about 50.2 seconds
  after timer confirmation. No IP fallback succeeded or was requested.
  Evidence: `vm-outage-2026-11-10T10-44-48.423Z-123bd8f3-evidence.json`.
- **Tunnel/preview reboot recovery passed.** The primary agent was verified idle and both host
  services enabled before scheduling reboot. Control recovered at 46.1 seconds
  from test start, about 34.1 seconds after scheduling. The first preview request
  **before opening a terminal** returned 503 because the development application
  was down, without the earlier incorrect global discovery label. Terminal
  readiness converged on its second attempt; new boot ID, firewall, listener and
  token permissions passed. After explicitly starting the fixture application,
  control and preview both returned 200 at 72.5 seconds. This does **not** claim
  automatic restart of a user-launched `npm start` process.
  Evidence: `vm-reboot-2026-11-10T10-45-53.198Z-003abc95-evidence.json` and its matching
  `host-after-reboot-…txt`.

The origin-independence conclusion combines journal/runtime identity, CNAME-only
DNS, host listener/firewall inspection and observed control/preview failure during
connector outage. The debugging credential receives401 for direct Cloudflare
tunnel inventory reads; do not describe that unavailable inventory as inspected.

## Endpoint-to-scenario inventory and bounded gaps

Browser `ws-{workspaceId}` routes select either the shared VM backend or the instant
container DO; callbacks travel from agent to API. Local references below complement
live proof and do not turn unexecuted scenarios into live passes.

| Caller / exact route family                                                                                                                  | Live status                                                                                                                                                                                                                                                                                                                                                                                                                                   | Complementary local verification                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Readiness, management and `GET /api/workspaces/:id/boot-log-token` → workspace `/boot/logs` WebSocket                                        | Fresh VM readiness/heartbeat and actual creating-phase boot frames pass.                                                                                                                                                                                                                                                                                                                                                                      | [Readiness/transport contract tests](../../apps/api/tests/unit/node-agent-contract.test.ts), [boot-log proxy tests](../../apps/api/tests/unit/ws-proxy.test.ts).                                                                                                                      |
| Terminal/ACP/chat prompt, stream, steer, cancel and reconnect                                                                                | Final terminal transport passes. Initial real-agent follow-up/steer/cancel/reconnect passes; these interaction scenarios have not all been repeated after the final reboot.                                                                                                                                                                                                                                                                   | Existing authenticated agent-session suites; real PTY group regression and scoped-environment regression.                                                                                                                                                                             |
| `/workspaces/:id/ports/:port/*`, preview access and `/api/workspaces/:id/local-forward`                                                      | Final HTTP/WS/CLI, credentials, isolation and outage/reboot results above.                                                                                                                                                                                                                                                                                                                                                                    | [Real workerd preview upgrade tests](../../apps/api/tests/workers/workspace-preview-websocket.test.ts), [Go proxy credential tests](../../packages/vm-agent/internal/server/port_proxy_credentials_test.go), restart discovery regressions.                                           |
| Files, Git status/diff and `GET/POST/DELETE /workspaces/:id/worktrees`                                                                       | Exact file bytes and worktree CRUD pass for both runtimes.                                                                                                                                                                                                                                                                                                                                                                                    | [Worktree tests](../../packages/vm-agent/internal/server/worktrees_test.go), file-transfer/ownership suites.                                                                                                                                                                          |
| Private `/git-credential` → agent exchange → `POST /api/workspaces/:id/git-token`                                                            | Real clone/push and external denial pass. **Latest update:** instant fresh terminal exchange passes on 90c without injected environment; fresh VM exchange also passes on 90c; post-reboot original-chat continuity remains a separate gap. No live provider credential was revoked or deliberately expired.                                                                                                                                  | [Credential retry tests](../../packages/vm-agent/internal/server/git_credential_retry_test.go), [API Git-token tests](../../apps/api/tests/unit/routes/workspace-git-token.test.ts), [tunnel ingress tests](../../packages/vm-agent/internal/server/tunnel_ingress_test.go).          |
| `POST /api/workspaces/:id/callback-token/renew`                                                                                              | Lifecycle operations and subsequent callbacks observed. No wait through the live renewal-age threshold; instant receives fresh credentials on wake.                                                                                                                                                                                                                                                                                           | [Real workerd renewal tests](../../apps/api/tests/workers/workspace-callback-token-renewal.test.ts), [real-SQL generation fencing](../../apps/api/tests/unit/routes/workspace-credential-generation-real-sql.test.ts).                                                                |
| MCP `/mcp/build-and-publish`, `/mcp/build-and-publish-jobs/:jobId/start` and `/cancel`; `/api/projects/:id/compose-publish-release` callback | Both runtimes reject missing/workspace-only credentials 401 at all three management routes. **Authorized positive publication was not run; instant publication is explicitly unsupported.** The normal VM operation unconditionally chains Docker build, R2 upload and release creation; there is no build-only/dry-run. It uses the same tested `fetchNodeAgent` transport, but denied calls do not establish a complete build/release path. | [MCP build tests](../../apps/api/tests/unit/mcp-build-and-publish.test.ts), [real-SQL publication fencing](../../apps/api/tests/unit/routes/publish-hardening-real-sqlite.test.ts), [bounded cancel tests](../../apps/api/tests/unit/services/deployment-publish-job-cancel.test.ts). |
| `/api/projects/:id/tasks/request-upload` → presigned R2 → session `/prompt` attachments → `POST /workspaces/:id/files/upload`                | Full path passes for fresh 90c VM and instant, including agent and independent workspace digest checks. Original post-reboot VM chat continuity remains separately documented. Temporary R2 uploads follow managed retention; there is no normal user deletion endpoint.                                                                                                                                                                      | [Upload route tests](../../apps/api/tests/unit/routes/attachment-upload.test.ts), [transfer tests](../../apps/api/tests/unit/services/workspace-attachments.test.ts), [real workerd shared attachment tests](../../apps/api/tests/workers/shared-session-attachments.test.ts).        |
| MCP `/mcp/secret-exec`, status and cancel through runtime-aware forwarding                                                                   | Harmless `secretNames: []` jobs completed through initial real VM and instant agents. No live secret rotation or unrelated-job cancellation.                                                                                                                                                                                                                                                                                                  | [MCP authorization](../../apps/api/tests/unit/routes/mcp-secret-exec.test.ts), [execution integration](../../apps/api/tests/integration/secret-exec.test.ts), [Go handlers](../../packages/vm-agent/internal/server/mcp_secret_exec_test.go).                                         |
| Workspace create/rebuild/stop/restart/delete and snapshot sleep/wake                                                                         | Initial managed sweep covers each lifecycle operation; final fresh provisioning, temporary-workspace deletion, reboot and instant exact-byte restoration repeated.                                                                                                                                                                                                                                                                            | Lifecycle cancellation/retry and snapshot upload/restore suites.                                                                                                                                                                                                                      |
| Provisioning failures, cancellation, stale incarnations, delayed Cloudflare creates and cleanup retries                                      | Normal old-fixture cleanup verified; destructive provider/account scenarios use local boundary tests.                                                                                                                                                                                                                                                                                                                                         | Real-SQL [lifecycle](../../apps/api/tests/unit/services/node-tunnel-lifecycle.test.ts), [race](../../apps/api/tests/unit/services/node-tunnel-races.test.ts) and [cleanup](../../apps/api/tests/unit/services/node-tunnel-cleanup-edge.test.ts) tests.                                |
| Account credential revocation during tunnel cleanup                                                                                          | **Local only:** repeated401 sweeps retain resources/identity and back off, then restored access cleans owned resources. No shared credential or live connector token revoked.                                                                                                                                                                                                                                                                 | Stateful regression in `node-tunnel-cleanup-edge.test.ts`; connector outage above is a different scenario.                                                                                                                                                                            |

## Earlier managed results and defects retained

The initial candidate established real agent site creation, managed execution,
files/Git/CLI/diagnostics and cross-user boundaries. Initial VM lifecycle timings:
rebuild 202→running 26.65 seconds; sleep 28.4 seconds; follow-up wake restored source
and preview on a replacement workspace on the same VM; stop 7.4 seconds;
restart 25.4 seconds, source/site healthy 29.1 seconds. Actual VM steering had a
persisted `steered` outcome. Instant steering showed accepted intent/eventual
reply, not interruption of the foreground command. Numeric message-sequence
matching across wake was a harness limitation; independent prompt/message-ID
verification established the restored reply.

The sweep found and fixed SAM cookie leakage into preview applications, automatic
following of application302 redirects, dropped upgraded response sockets,
standalone PTY `Setpgid`/`Setsid` conflict, app Bearer shadowing SAM preview auth,
and per-workspace discovery loss after reboot. The old reboot test deliberately
remains a failure record: control recovered, but preview selected the nonexistent
global `/workspace` label even after the app restarted. The final reboot above
passed after the runtime/durable-metadata discovery fix.

Existing rebuild semantics reuse the container; adding host-PID devcontainer
settings requires a fresh workspace. The final fixture used that full devcontainer
from creation. No public-IP bypass was used to inspect or control the host.

Old VM/host workspace cleanup returned 200 then 404. The cleanup journal reached
`cleaned` and authoritative DNS inventory returned zero records. Direct tunnel
inventory remained unavailable 401; deletion evidence is the successful cleanup
journal, not a claimed independent tunnel listing. The 2c7 VM was also explicitly
deleted through the normal API at 11:11; its journal reached `cleaned` at 11:16:16.591
and authoritative DNS returned zero records at 11:17. Instant and fresh 90c VM cleanup are also complete; final journal/DNS confirmation is recorded below.

## Local and visual validation

- Full API suite on the initial integrated candidate: 15,719 tests in 1,067 files
  passed (four tests/three files skipped). This is not a rerun count for `90c87b98a`.
- Root fast checks passed; cloud-init 245 tests include executed firewall/deadline
  behavior; installer clean-consent/preserve-upgrade coverage passed 21 tests.
- Real workerd preview upgrade regression covers VM and instant branches.
  Go full/race validation and independent reviews cover preview credentials,
  restart discovery and PTY process-group behavior; the newest environment fix
  has focused/race coverage and its instant terminal Git exchange now passes live on 90c.
- Both 2c7 and 90c CI code checks, including the root Test job, passed. The specialist
  review-evidence gate is separate and remains open until completion review.
- The earlier local full web run passed 5,056 assertions across 402 files but failed due
  to a toast timer after jsdom teardown; its isolated 11-test file passed. Tracked
  separately; do not call that earlier run a clean full-suite pass.
- Eight generated admin controls have reviewed desktop/mobile screenshots,
  including 320px stress. Changes travel through existing revisioned settings
  PATCH to typed definitions and the tunnel API/cleanup consumers. Actual staging
  settings were not changed by the intercepted visual interaction tests.

## Original ACP chat recovery boundary

The 2c7 host reboot recovered tunnel/control/terminal/preview routing, but not the
original ACP chat. The first follow-up encountered no active SessionHost;
`dead_runtime_reconciliation` at 10:50:19 failed the task and stopped the workspace
at 10:50:28. Its pending attachment then received `wake_refused` at 10:50:30. At this
first failure the snapshot was pending without sleep timestamps, so this was not
idle snapshot sleep.

A later normal workspace restart plus agent resume reached browser `ready`, but
canonical task/chat ownership remained failed/stopped. It used ACP `NewSession`,
not `LoadSession`. A prompt completed at 11:05:32, yet an exact after-cursor history
query found no durable assistant reply or attachment digest. The **second**
automatic workspace deletion followed a verified snapshot at 11:06:00.871 and
completed sleep at 11:06:15.227, then deletion at 11:06:17.708. It is not evidence of
unsnapshotted data loss. Generic `vm_agent_error` event envelopes contained INFO
lifecycle successes and must not all be classified as errors.

This is tracked by existing idea `01KZM7R67CN19RA29MV6EE0DAA`.
`vm-reboot-recovery-final-disposition.json` preserves the exact timeline. UI Retry
creates a new task with parent lineage; runtime restart/resume does not resurrect
a terminal task. These recovery/reconciliation paths are unchanged from `main`;
no controlled legacy-IP comparison was run. Treat original-chat continuity as an
explicit P2 lifecycle limitation, not a tunnel regression or an all-E2E pass.
Fresh 90c normal-agent attachment/Git checks subsequently passed independently.
A further normal prompt at 11:29 produced new durable assistant message IDs and
confirmed app health. These do not retroactively establish original-chat recovery
after reboot.

The agent turn was idle and the managed execution job had authoritatively
completed exit 0 at 11:20:45.978, but `runtimeWorkState` still displayed `active`
about nine minutes later. This is not proof of a live job or a canonical idle
invariant. Existing execution/reporting paths are unchanged; the separate stale
indicator issue is tracked as `01M72KJY0QWX6PFAYHN3M6DEM1`. No cancellation was
needed or performed.

## Completion and observation limits

All owned current/historical compute API absence checks passed at 11:33:55.
Instant has a deleted D1 tombstone with runtime termination confirmed. Cloudflare
verification at 11:36:45 confirmed all three owned journals `cleaned` (the last at
11:36:09.444) and zero records across all three authoritative DNS lookups. Direct
tunnel-inventory reads returned 401 with the debugging credential; journal
cleanup success and DNS absence are separately verified. Tiny staged R2
attachments retain their normal retention policy; immediate R2 deletion is not
claimed.

The read-only task-completion audit passed research/checklist, substantive diff,
acceptance verification, UI propagation, resource selection and vertical-slice
checks within the declared scope. The [archived task](../../tasks/archive/2026-11-10-cloudflare-tunnel-staging-proof.md)
records the final audit. Final PR publication, CI and merge gates remain the
coordinator's workflow; this result does not claim production rollout.

The authorized positive MCP publication gap is retained as a coverage boundary:
there is no dry-run, and an external release is not required to verify the shared
tunnel transport. No new publication feature is being added for this test.
Dedicated framework HMR, live callback-age renewal and live shared-account/
connector-token revocation were also not performed; the table states their
substitute coverage.

Instant automatic port discovery remains intentionally absent; manual preview
routing is verified independently. General public TCP/UDP exposure is outside the
existing HTTP/WebSocket product contract. Deployment-role app ingress is unchanged (since the
2026-11-10 hardening, deployment nodes use the tunnel for their agent channel only).
Legacy nested-hostname direct TLS remains a separately tracked pre-existing path;
current Worker routing and new-agent direct R2 uploads do not use that path.
