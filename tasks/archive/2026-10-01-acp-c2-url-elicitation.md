# ACP C2 URL elicitation

## Problem

SAM currently advertises and handles ACP forms only. A remote MCP service that asks a pinned wrapper to open an HTTPS authorization URL cannot receive a durable creator decision in chat, and its independent completion notification has no authoritative Cloudflare record.

## Research

- The approved v2 plan is at idea `01M3P2E0JJNQRXX020P65ZRKEJ`; #2206 is the merged C1 base.
- Historical stock behavior (the reviewed C2 backport below replaces the incorrect Codex completion source): pinned `claude-agent-acp@0.81.2` forwards remote MCP URL requests and emits `elicitation/complete` after server-side `elicitation_complete`; its localhost OAuth startup is a distinct branch. Pinned `codex-acp@1.13.1` sends URL requests, tracks accepted IDs, and emits completion on `serverRequest/resolved`.
- `acp-go-sdk@v0.13.5` decodes URL requests and completion notifications, but loses optional scope fields. SessionHost prompt/generation is the authority.
- InteractionStore owns encrypted request/answer, idempotency, attention projection, expiry, and no-wake delivery. URL completion must be recorded independently from consent and delivery.
- ACP draft spec: https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/rfds/elicitation.mdx

## Checklist

- [x] Add dormant URL-specific capability/start contract and conservative HTTPS request validation in Worker and Go.
- [x] Add encrypted URL detail and bounded creator decision with safe host display and explicit open gesture; reject loopback-dependent flows.
- [x] Record authenticated generation-fenced `elicitation/complete` independently, including early and duplicate notification races.
- [x] Exercise pinned wrappers through deterministic externally completing HTTPS service fixtures; cover cancellation, reconnect, stale/no-waiter and privacy canaries.
- [x] Add real chat UI, desktop/mobile screenshots, and public docs with supported and unsupported behavior.
- [x] Run Go/Worker/TS checks and local specialist reviews; send parent exact draft head and evidence, then wait for staging slot.

## Acceptance

Only a live bound creator can review and answer a bounded remote HTTPS URL request. The Worker remains the sole request/answer authority. Opening a URL means consent to navigate, not completed authentication. A matching wrapper completion is tracked independently and never resurrects a stale runtime. Full URL and human data remain encrypted and owner-only; generic state stays safe. The branch remains draft, dormant by default, unmerged, and undeployed to production.

## D auth diagnostics handoff

D owns the static safe reason codes `model_provider_credential_missing`, `model_provider_credential_rejected`, `mcp_endpoint_needs_auth`, `model_unavailable`, and `unsupported_loopback_auth`. C2 should emit `unsupported_loopback_auth` only when trusted URL eligibility evidence establishes a loopback callback; a generic URL rejection does not establish that reason. Native model credentials link to existing credential settings or guided provider login; MCP endpoint authentication links to that service's settings and only a verified remote URL flow where available. Never put raw URLs, tokens, schema text, provider error bodies, or inferred credentials into events or diagnostics. A URL `accepted` receipt says the user consented to navigate; `urlCompletedAt` records the separate upstream completion notification and does not by itself assert that a provider account was authorized.

## UI audit

This is a component update in production chat. Considered (1) a modal, (2) a chat card with inline full URL, and (3) a chat card with safe host and owner-only detail loading. Chose (3) to keep the decision in conversation and hide URL query secrets until the creator opens the link. The long request collapses after 240 characters so mobile actions remain visible; this was fixed after the first screenshot pass. Final Playwright capture covers 30 history messages, Unicode/HTML-like text, owner and noncreator states, completion, uncertain receipt retry, and 320px overflow. Rubric: hierarchy 4/5, clarity 4/5, mobile 4/5, accessibility 4/5, consistency 5/5. A screenshot of the mobile card still shows the chat's existing sticky header above it, but the action controls remain visible and operable. Evidence is in `docs/notes/acp-c2-screenshots/`.

Parent review also found an asynchronous decision race. The card now checks current creator authority, interaction state, deadline, and identity after the digest resolves; Playwright holds the digest while the request settles or access is revoked, then verifies no answer is sent. The URL rollout flag and deadline are forwarded through both deployment workflow config-sync passes, with a workflow regression that checks override propagation and the false checked-in default.

The mobile audit now includes a top-of-card capture showing title, status, deadline, and request, plus a scrolled-action capture showing the destination and buttons. The long card is vertically scrollable within the existing chat; both parts are reachable. The Go URL registry retains bounded generation-lifetime ID tombstones, so a late duplicate completion cannot bind a reused ID. A shared JSON URL corpus is run by Go and TypeScript. URL length, elicitation-ID length, and explicit redirect depth are lower-only configurable limits, forwarded through the deployment workflow and public configuration docs.

## Verification boundary

Layer tests currently exercise installed Claude URL forwarding and external HTTPS completion, pinned Codex URL/completion source checks, the pinned Go SDK wire through SessionHost, Cloudflare InteractionStore and callback handling, and production chat under Playwright. They do not yet form one live wrapper → Go → Worker → browser test. The published Codex CLI is not executed against an external service. Keep URL capability dormant and do not advertise verified runtime support until that gap is closed or the parent explicitly narrows the acceptance gate.

A disposable external HTTPS MCP service is prepared at `tests/fixtures/acp-c2-remote-service.mjs`, with an operational staging and cleanup plan beside it. `pnpm test:acp-c2-remote-service` passes against a real MCP SDK client, including service completion before answer, duplicate/replay notifications, and MCP endpoint authorization. This is fixture readiness only; the staged pinned-wrapper/VM/Worker/browser gate remains outstanding and no staging resources have been changed.

## Upload transport deadline repair — 2026-10-02

The retained Node upload probes did not model the Go HTTP server's socket read
limit. `HTTP_READ_TIMEOUT` defaults to 15 seconds, whereas `FILE_UPLOAD_TIMEOUT`
is 120 seconds. The handler's context previously bounded workspace commands but
did not extend or interrupt HTTP body reads. The server deliberately has no
write deadline, so the unused write-timeout config default is not this defect.

The upload handler now applies its context deadline to the HTTP read controller
after workspace authorization and validation. This retains an earlier caller
deadline, the existing size limits, and the configured upload bound without
changing ordinary API or WebSocket timeouts. Go resets the connection deadline
when dispatching the next request.

`TestFileUploadSocketDeadline` uses real HTTP sockets and the production CORS
middleware with a 100 ms API read timeout. Before the repair, both 300 ms paced
uploads (known-length and chunked) failed with HTTP 400 / file-read timeout;
the fast control passed. After the repair, all five cases pass: fast upload,
both paced uploads with exact file-content/receipt checks, and both over-budget
uploads rejected without creating a file. The complete `internal/server` test
package passed with Go 1.26.6 (`GOMAXPROCS=2`, `-p 2`, `-count=1`). Independent
read-only Go review found no blocking issue and checked keepalive deadline reset.

This demonstrates a local transport defect. It does not establish the cause of
the earlier deployed “Network connection lost” failures, nor prove delivery of
the patched CLI/adapter through Cloudflare. Those live and distribution gates
remain open; there was no extra staging deployment or runtime provisioning for
this repair.

## Retained candidate build preparation

The reviewed `codemode1` tar was not present in the resumed coordinator's
workspace; the original C2/integration workspaces are deleted and their retained
snapshots have no filesystem payload. No surviving copy has been established.
The checked-in source patches still apply cleanly to their exact tag commits,
and their resulting diffs match the reviewed hashes.

`ACP Codex Review Build` produces a replacement review artifact on a standard
hosted Ubuntu 22.04 runner, bounded to two Cargo jobs and 120 minutes. It retains
binaries, licenses, provenance, both upstream and resulting Cargo locks, the
adapter lock, and the previously reviewed official helper/signature bytes in a
mode-preserving tar for seven days. The exact upstream tag has workspace version
0.156.1 but lock entries at 0.0.0: workspace lock normalization is allowed only
if every external package record stays identical, then the build is locked.
Disk usage is reported before and after removing unused hosted-runner toolchains.
The V8 helper is downloaded with its reviewed archive/extracted-byte hashes;
this does not claim a new signature verification.

Shell syntax, workflow YAML parsing, exact applied-patch hashes, and independent
read-only review passed before the first build. A replacement's byte hashes
must be independently reviewed and its installed runtime harness/rollback tests
passed before changing any trusted catalog or attempting a live matrix. The
workflow does not deploy, install into SAM runtimes, or update that catalog.

## Replacement artifact verification — 2026-10-02

Build 37073680241 succeeded at source head55dcc9074; the checked-in delivery
runbook records its retained artifact and distinct codemode2 identity/catalog.
All raw artifact checksums, source provenance, adapter lock and unchanged
external Cargo lock records were verified locally. Actual CLI/adapter versions
match the patched identities. The ten-case real Go process probe passed in both
direct and Code Mode execution. The installer tamper/rollback suite passed. The ten-case process probe also
passed through installed entrypoints. Runtime catalog and missing/tampered/non-
executable helper checks passed after correcting a local catalog-copy path.
Independent review verified every catalog entry, old-catalog preservation and
build provenance; no blockers to local candidate adoption remained. This is
not live staging or production approval.

Current main was merged at4e1cbd2ca with both the C2 conversation/profile tests
and incompatible-VM-before-token guard preserved. API typecheck, route tests
16/16 (after an initial cold-import timeout), and targeted Go upload/snapshot
regressions passed. Exact merge-head CI37075223640 was dispatched.

## Live upload verification and restored staging — 2026-10-03

Exact-head CI37077386224 and staging deployment37079961625 passed at67e3aedd6.
One cx23 VM with Node22.23.2/x86_64 accepted a4,096,000-byte canary whose stored
size and SHA matched, then all eleven reviewed bundle parts returned200. See the
current delivery runbook for fixture IDs and bounded evidence. The archive was
not assembled/verified or executed; form/URL continuation remains unproven.

A root helper error (new token-login per command) exhausted the IP login limit
before installation. Testing stopped. All three overrides were removed and
rollback37082605802 passed deploy/smoke with effective flags false/false/false.
VM, workspace, temporary profile and MCP connection were deleted at about01:00:43;
API nodes and D1 confirmed zero active nodes. The planned00:52 cleanup deadline
was exceeded by approximately nine minutes while waiting for the legitimate
login reset; no limiter bypass or further testing occurred. Helpers now retain
private browser authentication for reuse and cleanup. No production change.

#### October 3 retry checkpoint

- Runtime upload/checksum/start/model checks passed on one bounded VM fixture.
- Form tool returned a caught MCP exception; no Cloudflare interaction or human
  answer was recorded. Live form/URL continuation remains incomplete.
- Added safe fixture error diagnostics and HTTP tests distinguishing missing
  capability from actual accept/cancel. Do not infer a live cause from local repro.
- Root-owned release directory accessibility failed until corrected in fixture;
  distribution installer repair has a root-to-unprivileged execution regression.
- Watchdog cleanup completed 01:52:47 UTC, including restoring user settings;
  zero staging VMs and no fixture D1 rows. Production unchanged.
- Rollback `37087985870` succeeded including smoke; all three effective flags
  false, no staging ACP overrides, health 200.
  See the staging delivery runbook for complete evidence and limitations.


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
