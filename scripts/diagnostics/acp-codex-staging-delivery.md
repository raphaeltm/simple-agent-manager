# Isolated Codex C2 staging candidate — review before mutation

## Current replacement candidate (2026-10-02)

The earlier `codemode1` CLI artifact was not found in the resumed workspaces or
relevant retained snapshots. The reviewed build workflow rebuilt the same exact
source patches in [run 37073680241](https://github.com/raphaeltm/simple-agent-manager/actions/runs/37073680241)
at `55dcc907461053427cf8145078ba4864b8c25c98`. It completed successfully using
Rust 1.95.0, two Cargo jobs and the upstream `dev-small` profile on Ubuntu 22.04.
The run retains `acp-codex-review-55dcc907461053427cf8145078ba4864b8c25c98`
for seven days, containing `acp-review.tar.gz`, checksums, both Cargo locks,
adapter lock, source/build provenance, licenses and the upstream helper signature
bundle. Download and verify this artifact before its retention deadline; it is
not a production distribution channel.

The replacement identity is
`sam-codex-acp-1.13.1-sam-c2.1+cli-0.156.1-sam-c2.1-codemode2`.
Its [external catalog](pinned-codex-catalog/sam-codex-acp-1.13.1-sam-c2.1+cli-0.156.1-sam-c2.1-codemode2.sha256)
has SHA-256 `c984a43334aab0968f8a728e8944fd36f99a613e9402eef77243d5ca3ff56d09`.
The new CLI SHA-256 is
`11f272b424096cffe627690f744a31308ca8bb2b724d954c86e7ba4721a99e77`;
the adapter and official Code Mode helper are byte-identical to `codemode1`.
All downloaded checksums passed, the source provenance and adapter lock matched
the pinned patched sources, and external Cargo lock records remained unchanged.
The actual binaries retain the distinct `0.156.1-sam-c2.1` and
`1.13.1-sam-c2.1` runtime versions. The external release identity distinguishes
these rebuilt CLI bytes; the old catalog remains available for installer rollback
verification. The new
VM selector accepts only `codemode2`: operational rollback also requires the
matching VM selector version. To return to stock, remove any fixture marker,
disable trusted forms/URL configuration, then start a fresh host as described below. Catalog retention alone
does not prove operational rollback.

The raw replacement passed all ten real Go→adapter→CLI local callback cases:
both completion orders, accepted without completion, decline and cancellation,
in direct and Code Mode execution. Local callback evidence is not live Cloudflare
persistence or provider readiness. Installation/rollback and installed-entrypoint
results are recorded in the active task. No new staging deployment, distribution,
activation or production change is implied by this build.

## Codemode2 upload verification — 2026-10-03

Exact catalog-head CI 37077386224 and feature deployment 37079961625 passed.
Cloudflare readback confirmed all three ACP flags enabled and required VM agent
`67e3aedd611f3c32562d70f1bfd9b930fc486681`. One Elysia cx23 fixture used
workspace `01M3ZJ7DR2NFC496070QT3NT1J`, node `01M3ZJ7DFFRGK2A44M83W4V2VH`
and chat `bbb93140-1c85-43d1-ad66-4bfff464b754`. Runtime checks confirmed
Node22.23.2 and x86_64. The explicit architecture filter initially rejected the
active cx23 offering because its pool metadata had a null architecture; keeping
the exact cx23/fsn1 offering without that filter succeeded. Runtime architecture
was checked before transfer.

The authenticated file proxy returned200 for a 4,096,000-byte canary; terminal
readback confirmed its size and SHA-256
`9a83675050d9fa6b277375e95e765acf6d91f014c792d0eb79f9a673f135a84c`.
All eleven reviewed tar parts then returned200 through one authenticated
APIRequestContext (ten 45MiB parts and one 4,536,320-byte part). This verifies
live upload delivery after the socket-deadline repair. It does not identify the
closing side in the historical failures or prove assembled archive integrity,
runtime installation, initialization, or form/URL continuation.

The root helper unnecessarily logged in anew per command and exhausted the
staging token-login IP limit before installation. No agent session, fixture
service, public port, form request or URL request was started. The helper now
persists private browser storage with mode0600 and reuses that authenticated
session. Future verification must establish and persist authentication **before
provisioning**, reuse it for all browser/API operations, and retain it until
cleanup is confirmed. Respect Retry-After; do not reset the limiter or rotate IPs.

All three Environment overrides were removed. Dormant restore37082605802 passed
deploy and smoke; Worker readback was false/false/false and health200. Cleanup
was delayed until the legitimate01:00 login reset because no cached authenticated
session remained. At approximately01:00:43UTC, node/profile/MCP-connection DELETEs
returned200, GET nodes returned an empty list, and D1 showed no fixture node or
workspace and zero non-deleted nodes. Temporary profile
`01M3ZJRW91YJJCWKN1EESNXPYD` and connection `01M3ZJRXAWPZ329VVRG71591H3`
were removed, along with the local fixture secret. This is SAM's strict provider
termination acknowledgement plus D1 removal, not an independent provider inventory
query. The00:52:04 cleanup deadline was missed by approximately nine minutes;
the test did not resume during the overrun. Production was unchanged.

## Historical codemode1 evidence and staging procedure

The remainder records the earlier candidate and live attempts. Its `codemode1`
identity, catalog and local tar paths are historical; use the replacement identity
and catalog above for any future reviewed rehearsal. The failed-upload hold and
required live matrix remain in force until their gates are met.

## Local Code Mode host repair awaiting review

The second isolated fixture on `da47da3e5` reached a marked Codex prompt, but
the CLI could not spawn `payload/codex-code-mode-host`; the six-file catalog
below omitted that executable. The prompt ended without an MCP request or a
Cloudflare interaction receipt. The second feature deployment was
`36946842328`; dormant restore `36954009696` passed smoke, all three ACP flags
were false, staging overrides were absent, and no non-deleted nodes remained.

The **local-only** replacement is
`sam-codex-acp-1.13.1-sam-c2.1+cli-0.156.1-sam-c2.1-codemode1`.
Its seven-file [external catalog](pinned-codex-catalog/sam-codex-acp-1.13.1-sam-c2.1+cli-0.156.1-sam-c2.1-codemode1.sha256)
has SHA-256 `23efaca5c774438b4c8c01ddeb0f7321d6b6bd06c1cfbab644b9b08222310c68`.
The host executable SHA-256 is
`45ba654b0e145406f3316be4729b886980ce811aa2e3b6ed4e033dd41ab524f1`.
It came from the official exact-tag `rust-v0.156.1` Linux x86_64 musl host
archive; its downloaded SHA-256
`a929daa9f6a0bddc00c0c9e6402df117b125acd96f9d554f6c99c32c7e66c608`
matches the GitHub release asset digest. GitHub's annotated `rust-v0.156.1`
tag resolves to source commit `b412ff32c417f855c2b2d1581b77058eed87c84b`,
the CLI source pin. The tag itself is unsigned. The release's `.sigstore`
bundle has SHA-256 `0904ffcab71b13a942bb2cae30dde5f6fad9609d8958699c2b4b40778b63ddfa`;
Cosign 3.1.3 `verify-blob` returned `Verified OK` for the **extracted host
binary** with GitHub Actions OIDC issuer and identity
`https://github.com/openai/codex/.github/workflows/rust-release.yml@refs/tags/rust-v0.156.1`.
The certificate names the same source commit. The bundle does not sign the
archive bytes; the archive digest is checked separately against GitHub's
published asset digest. GitHub-native `gh attestation verify` returned 404 for
the archive, so there is no separate GitHub attestation claim.
A local source build was attempted
with the pinned Rust toolchain and two jobs, but the published V8 150.4.0 crate
has no prebuilt sandbox archive and its source build lacks Chromium Rust vendor
files. The host is therefore **official exact-tag prebuilt and unpatched**, not locally built or derived from the SAM CLI patch;
the CLI and adapter remain the previously verified patched artifacts. The
release provenance and local verifier record this distinction.
The helper is a static PIE Linux x86_64 musl executable and ran in the local
Debian x86_64 process harness. The paired patched CLI still requires its
glibc/OpenSSL runtime libraries, and the adapter requires Node 22 or newer;
the VM selector checks x86_64, Node 22+, full release bytes, executable bits,
and both wrapper identities. The helper has no `--version` flag, so the
catalog digest and verified release provenance are its identity checks.

The local review tar is
`.codex/tmp/sam-codex-c2-delivery-codemode/sam-codex-acp-1.13.1-sam-c2.1+cli-0.156.1-sam-c2.1-codemode1.tar`,
SHA-256 `1bcc5256dbc298ae84c06771617d4ee31467e761aded640675e6cf8e5a3d126d`.
It has a relative `current` link and has not been distributed. The installed
entrypoint Go harness reproduced **no receipt** with the prior hostless bundle,
then passed ten cases with this bundle: each of the five outcomes (both
completion orders, accepted without completion, human denial, cancellation)
ran through both direct MCP and a Code Mode `exec` call to the MCP fixture,
with local receipt, answer, and actual service completion kept distinct.
The VM candidate check passed against both the installed release and a fresh
extraction of the review tar; installer tamper, non-executable host, tampered
host rollback-target rejection, and approved-prior rollback rehearsal passed.
These are local fixture
results, not Cloudflare persistence evidence. No new staging cycle or rollout
is authorized by this local preparation. The procedure below names the current seven-file local candidate and requires coordinator review before any staging use.

The branch adds an explicit per-session selector, `SAM_CODEX_C2_CANDIDATE=1`,
resolved through the authorized Cloudflare runtime-assets endpoint for a dedicated
project fixture profile bound to one manual workspace agent session. No VM-agent
host or fleet environment variable is used. This section records the original
explicit-selector implementation. The distribution follow-up also selects the
reviewed runtime automatically for fresh hosts with trusted forms/URL flags.
Stock npm pins apply only when neither selector is active. An invalid value fails
selection; removing/changing it during startup or restart fails closed. The
selected candidate runs `/opt/sam-codex-c2/current/bin/codex-acp`; it never invokes npm
or falls back to stock when candidate verification fails. It is checked before
selection and again before every start/restart, including crash recovery. The
adapter wrapper pins `CODEX_PATH` to its paired CLI. This is not a production
default, container-image change, or shared Sol change.

## Current local candidate artifact and supported runtime

- Identity: `sam-codex-acp-1.13.1-sam-c2.1+cli-0.156.1-sam-c2.1-codemode1`.
- Trusted seven-file catalog: [`pinned-codex-catalog/sam-codex-acp-1.13.1-sam-c2.1+cli-0.156.1-sam-c2.1-codemode1.sha256`](pinned-codex-catalog/sam-codex-acp-1.13.1-sam-c2.1+cli-0.156.1-sam-c2.1-codemode1.sha256); its SHA-256 `23efaca5c774438b4c8c01ddeb0f7321d6b6bd06c1cfbab644b9b08222310c68` is compiled into the VM agent. The catalog is outside the release. Runtime verification checks this hash, the exact release file set, symlink/executable constraints, every catalog digest, and actual wrapper versions. A release-owned `SHA256SUMS` cannot authorize changed bytes.
- Local delivery tar: `.codex/tmp/sam-codex-c2-delivery-codemode/sam-codex-acp-1.13.1-sam-c2.1+cli-0.156.1-sam-c2.1-codemode1.tar`, SHA-256 `1bcc5256dbc298ae84c06771617d4ee31467e761aded640675e6cf8e5a3d126d`. It contains `current` (relative link), `catalog/`, and `releases/`; it has not been uploaded or distributed. The host is checked as an executable against the seven-file catalog.
- Runtime: Linux x86_64, glibc with OpenSSL 3 and system libraries used by the built CLI, Node 22 or newer, `sh`, `find`, `sort`, `readlink`, `cut`, and `sha256sum`. The VM-agent check enforces x86_64 and Node 22+, runs both versions to catch missing dynamic libraries, and verifies file bytes. Use the existing Debian-based SAM devcontainer; no ARM or musl devcontainer support is claimed. The bundled adapter JavaScript was exercised by the installed-entrypoint Go process harness.

### Upload failure observed on 2026-10-02

The authorized exact-head Elysia cycle stopped before candidate installation or ACP initialize: all 15 authenticated SAM file-proxy multipart uploads returned 500. A single bounded 4,096,312-byte (about 3.91 MiB) diagnostic retry returned request ID `774898dc-f275-4b1e-8725-3a42bd06f2b8` at 03:56:40Z. Worker telemetry recorded `file_proxy.workspace_resolved` for the running workspace and correct node, then `request_error` with `errorName=Error`; it recorded no `file_proxy.upload_error` node HTTP response. The observability D1 record for that request ID classifies the exception exactly as `Network connection lost.` All 17 persisted API errors for the same chat session between 03:50Z and 04:00Z have that same category; no VM-agent error record is present for that node/workspace/session in that window. The available Worker stack consists of bundled `index.js` frames and does not locate the failing fetch/stream boundary. The node may have no record of a request that failed in transit, so the absence of node errors is not proof that it was healthy.

The client used Playwright APIRequestContext multipart with a `destination` field and one octet-stream file buffer. The diagnostic request had `Content-Length: 4096312` bytes and a multipart boundary; the reviewed bundle was split into fourteen 45 MiB parts plus a 3.91 MiB part. These are below the API's default 250 MiB batch ceiling and the VM agent's 50 MiB per-file ceiling. Earlier cycles uploaded thirteen 45 MiB parts through the same authenticated route, including on this Elysia project, so part count and file size alone do not explain the failure. The upload route, node fetch wrapper, timeout helper, and VM-agent upload handler are unchanged between that successful head (`947cceafc`) and this head (`0a082bf4f`). The present route forwards a size-limited request stream through `fetchNodeAgent` without classifying transport exceptions; a returned node HTTP failure would log `file_proxy.upload_error` and map to 400/413/502. The evidence therefore narrows this incident to a connection/stream failure before a normal node HTTP response, without proving whether the inbound client, Worker outbound fetch, or node-side connection closed first. Read-only GET success does not test this POST body path. Do not retry artifact transfer or claim C2 delivery from this cycle; a separate reviewed repair and authorization are required before another staging run.

Local boundary reproduction is executable with `node scripts/diagnostics/acp-upload-boundary-local.cjs`: it uses the retained helper's Playwright `APIRequestContext.fetch` multipart shape with a fresh 4,096,000-byte buffer for each of two requests in one context. Both reached a local streamed proxy and node endpoint with HTTP 200. The probe retains and asserts each request independently: both were 4,096,312 bytes; `Content-Type` contained a valid WebKit multipart boundary, each stream was initially unlocked and consumed once, and each forwarded multipart parsed as exactly `destination=../.private` plus a `files` octet-stream part named `bundle.part-15` with byte-for-byte matching content. This proves the current client shape works on the tested local Node path only. The earlier successful cycle's exact client helper source is no longer retained, so a byte-for-byte driver comparison is unavailable.

The Hono route test uses the real route and size-limited stream but replaces `fetchNodeAgent` with a mock; the closure case substitutes Node `fetch` inside that mock. It confirms that the same-size multipart body/boundary reaches the mock unconsumed and parses after forwarding. The closure test also asserts that the receiver got body bytes and actually destroyed its socket. The real `fetchNodeAgent` wrapper and deployed Cloudflare runtime are **not** exercised by these route tests. A separate focused service test calls the real `fetchNodeAgent` and `fetchWithTimeout` against a local Node HTTP server, using the no-D1 VM path: an inbound stream abort after a node-acknowledged partial body and a node socket closed after the first upload chunk both reject before an HTTP response. The tests exercise adjacent layers separately; no single test runs the authenticated route, actual D1 lookup, and real network together. A one-off local `@cloudflare/vitest-pool-workers` probe also sent a 32-byte stream through real `fetchNodeAgent` to a host endpoint and passed; it was removed after proving local workerd connectivity because it depended on an external probe server. The two failure injections were run on Node transport, not workerd, and neither local runtime is Cloudflare's deployed Worker-to-VM network. These results show plausible ways to reach the live 500 category without identifying which live connection closed. No client or route repair is justified by this reproduction alone.

## Serialized staging procedure (requires coordinator review)

1. Confirm #2207 stack head and exact #2210 candidate SHA, no active `deploy-staging` run or competing staging owner, staging flags initially false, and zero non-deleted nodes. Keep all three PRs draft. Set only the staging ACP interaction and URL flag overrides to true, leave forms false, then deploy the reviewed branch once through `deploy-staging.yml`. Record the run and SHA; read back all three deployed flags and stop unless interaction and URL are true and forms is false. This deployment and readback must finish **before manual session creation**, because creation snapshots the interaction config. The opt-in VM agent uses stock behavior for every session without the marker.
2. Provision one exclusive project workspace/VM with the standard x86_64 Debian devcontainer. Record workspace, node and linked chat-session IDs. Verify the workspace's `chatSessionId` is non-null and the linked ProjectData conversation exists before uploading or creating the agent session; workspace creation currently treats chat-session creation as best-effort, so stop if this check fails. **Read back `node --version` in the actual devcontainer before uploading: require Node 22 or newer and stop/clean up if absent.** Create a project-scoped fixture Codex profile with only the `SAM_CODEX_C2_CANDIDATE=1` runtime env marker; do not set a project/global/skill env var. Before creating/selecting the agent session, split the reviewed tar into parts below the VM agent's 50 MiB per-file limit. Authenticate through the staging browser-token flow and upload parts directly to this workspace via `POST /api/projects/{projectId}/sessions/{chatSessionId}/files/upload`. In its authenticated workspace terminal, reassemble the exact tar, verify SHA-256 `1bcc5256dbc298ae84c06771617d4ee31467e761aded640675e6cf8e5a3d126d`, then extract with container-local `sudo` into `/opt/sam-codex-c2`. Verify the catalog outside `releases/`, the relative `current` link, and exact wrappers. Do not fetch a floating npm package or build on the fixture. No VM host control is involved.
3. Create one manual workspace agent session using `POST /api/workspaces/{workspaceId}/agent-sessions` with `agentType=openai-codex` and that project `agentProfileId`; the route validates the profile belongs to the workspace project and matches agent type. It also verifies the exact workspace/project/user/chat conversation task before `buildAcpInteractionRuntimeConfig` enables URLs; a chat ID alone cannot enable them. The trusted config travels in the authenticated VM agent session-create request and is applied to that session host before browser selection. Confirm the **exact task conversation match and URL-enabled host capability** before ACP initialize or any prompt; a missing task or capability fails closed. If the VM-agent process restarts or loses its session config, stop this matrix and create a fresh authorized session after investigating. Do not claim process-loss recovery passed or add an override; recovery remains a release limitation. The Cloudflare runtime-assets callback is bound to this session ID. Select Codex only after the bundle is present. Verify the installed wrappers report `codex-cli 0.156.1-sam-c2.1` and `@agentclientprotocol/codex-acp 1.13.1-sam-c2.1`; the ACP initialize agentInfo must also report `1.13.1-sam-c2.1`. Deliberately failing the catalog check on a disposable copy must stop selection before a stock fallback; restore the reviewed bytes before the live case. Never run a live prompt if identity or verification fails.
4. In one Codex session, run the Cloudflare-backed matrix: trusted loopback and accepted HTTPS URL; persisted receipt and human answer; service completion both before and after answer; accepted answer without service completion remains incomplete; decline and cancel; late, duplicate, wrong-ID, cross-server, stale/replayed completion; flag-off rejection; header-canary secrecy, retry, and project authorization. Record safe request/response IDs, result categories, timestamps, and exact session/connection identity, never URLs, tokens, headers, or prompts. The ACP completion callback alone is insufficient: verify Cloudflare receipt and durable answer separately. Claude's missing MCP URL capability remains a separate blocker and must not be called passed from this run.
5. Stop the test session. Remove the fixture profile marker; an existing host must not silently switch executables. Remove staging forms/URL overrides (or all ACP overrides), deploy the disabled configuration, and read back the effective bindings. Only then create a fresh host without the fixture marker and confirm stock `codex-acp`/`codex` exact versions (the existing SAM path installs stock pins if absent). Removing the marker alone is insufficient while trusted forms/URL flags remain enabled. Keep this check within a bounded compute window; do not retain a VM while waiting for deployment. Delete both sessions, the fixture profile/MCP connection/workspace/node and any duplicate provisioning IDs. Remove staging flag overrides, run the dormant restore deployment, read back all three flags false, and query D1 for **zero non-deleted staging nodes**. Record exact deployment/run IDs and cleanup evidence. Keep drafts and merge hold for coordinator personal review.

An earlier deployment attempt, run `36923440793`, was cancelled after Pulumi Up completed one `sam-pages-project` update and 22 unchanged resources. The Pulumi history records that update as succeeded and the current checkpoint was written at 20:43:04Z. Against the immediately pre-Up checkpoint, PagesProject ID, inputs, and ordinary outputs are unchanged; its modified timestamp and provider-internal raw state (`buildConfig`, `canonicalDeployment`, `deploymentConfigs`, `latestDeployment`, `source`) changed. The checkpoint has no pending-operations entry and the entire read-only R2 lock prefix is empty. Wrangler/Worker and later steps were skipped. The available Cloudflare token cannot independently read the live Pages project (403).

## Single-cycle outcome on `947cceafc94364dbc8b69756ba15e357ec7ec110`

Feature deploy `36936893936` passed deploy and smoke. Live readback showed interactions=true, URLs=true, forms=false. The one fixture used project `01KJNR9R3TEN3KX1ETE33852R8`, workspace `01M3WV8YB9VCQW0V6ET9GA6GF7`, node `01M3WV8Y1Z7FFZ98FQZMXPRTP3`, profile `01M3WVAFP9DGYEG8X18NY1NQRW`, conversation task `01M3WV8YJANXPFN1P73G39VP0X`, and chat `8c7b6c6a-5249-4bed-86ab-77ef0dd6097c`. The task matched the workspace/project/chat and was `in_progress`; authenticated ProjectData session GET returned 200. Authenticated browser-token file proxy uploaded 13 parts. Inside the devcontainer, the reassembled tar matched SHA-256 `e0e8616c432d8c5fa625f48e52abf47ca8db5ce05595cb2786eebd847f7d12cf`; the external catalog matched `5f6f8fe7256a682c2465ab334042c241992418050b8c7cec564bb7877a9e3218`; the paired CLI reported `codex-cli 0.156.1-sam-c2.1`.

The fixture's `crewai` Python devcontainer lacked `node` and `npm`; the adapter wrapper exited 127 (`exec: node: not found`). Work stopped **before manual agent-session creation, ACP initialize, or any prompt**. No live Cloudflare interaction receipt, answer, completion, replay, flag-off, or stock rollback result was obtained. The combined C2 matrix is **not passed**. No unreviewed runtime bootstrap or second fixture was attempted. Process-loss recovery and Claude URL capability remain separate release limitations.

Read-only next-fixture preparation: existing staging project `01KJVGMWX26SGQ5DX94GMTJRQN` (`serverspresentation2025/elysia`, default branch `main`) has a default `.devcontainer/devcontainer.json` that builds `.devcontainer/Dockerfile` with context `..`; that Dockerfile begins `FROM mcr.microsoft.com/devcontainers/typescript-node:22-bookworm`. These files were read through the authenticated SAM repository browser; no workspace was created. This is configuration evidence, not a runtime version readback: before any artifact upload, manual agent session, ACP initialize, or prompt, verify `node --version` inside the actual devcontainer and stop/clean up unless it is Node 22 or newer. The other inspected existing project, `01KTKXZ4ZZAT6MJFXRW1ZTQ7RB` (`serverspresentation2025/hono`), uses `typescript-node:20` and is ineligible for this candidate. Recheck the repository config at fixture time because `main` can change.

The profile marker and profile were removed, the workspace and node were deleted, and the conversation task was cancelled. D1 readback shows zero non-deleted nodes and zero rows for this fixture's workspace, node, profile, or agent session. Both staging flag overrides were removed. First dormant restore `36939673230` failed before Worker deployment when Wrangler reported `terminated` during the immutable arm64 R2 artifact check; read-only R2 listing confirmed both architecture artifacts existed. Cleanup retry `36940631481` passed deploy and smoke. Final live Worker readback shows interactions=false, URLs=false, forms=false; the GitHub Environment overrides are absent. The staging slot is released. The local process recorder is not evidence of live Cloudflare persistence.

### October 3 bounded retry: runtime startup passed; form remains unproven

Staging run `37085469696` deployed docs head `d7ae4357b` (application/runtime
`67e3aedd`) successfully. The single VM fixture ran from 01:34:37 through
watchdog cleanup at 01:52:47 UTC, within its 30-minute bound. Upload canary,
all eleven archive parts, assembled archive checksum, and external catalog
checks passed. The manually extracted release retained an owner-only directory
mode; changing that public release directory to 0755 allowed the workspace user
to verify both patched versions. The distribution installer has a separate
root-install/unprivileged-execution regression and repair under review.

The authenticated fixture initialized locally and through the public port route.
The agent started and observability confirmed `gpt-6-sol`; the shared Sol profile
was unchanged. A browser prompt received HTTP 202. The retained transcript later
contained two copies of that prompt: closing the first browser immediately after
clicking Send left delivery ambiguous, and an immediate message read did not
prevent a duplicate. Do not repeat a prompt merely because it is not yet visible.

The agent invoked the form tool, which returned `elicitation cancelled`; the
agent correctly reported that acceptance had not occurred. Cloudflare's
interaction list remained empty. This fixture text denotes a caught MCP request
exception, not proof of a human cancel action. Local HTTP reproduction shows that
missing elicitation capabilities can produce the same result before any callback;
transport failure or timeout remains possible. No live cause is established.
The fixture now distinguishes `request_error` from a normal cancelled answer and
records only capability booleans and a numeric error code, without error text,
credentials, URLs, or answers. Local HTTP tests cover missing form/URL capability
and actual form accept/cancel callbacks. No form or URL continuation claim is made.

The watchdog deleted the node, workspace, temporary profile, and MCP connection
(HTTP 200), restored and verified the original user model settings, and confirmed
zero nodes. Independent D1 reads found neither fixture node nor workspace.
All three staging ACP Environment overrides were removed; rollback deployment
`37087985870` completed successfully, including smoke tests. Independent readback
confirmed all three effective ACP flags false, no Environment overrides, and
API health 200.
Production was unchanged.

Local follow-up now runs four form cases through the installed patched CLI,
adapter, HTTP MCP fixture, and Go SessionHost client: accept and cancel in direct
and Code Mode operation. Each asserts a form receipt, consumed answer, subsequent
model call, fixture result, and replay rejection. All four form and ten existing
URL cases pass. This bypasses production manual-session initialization and live
Cloudflare persistence, so it narrows the failure without establishing its cause.
