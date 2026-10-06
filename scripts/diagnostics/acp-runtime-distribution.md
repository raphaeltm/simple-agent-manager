# Codex C2 runtime distribution preparation

This change distributes the reviewed Codex CLI/ACP adapter with a checksum-pinned
publisher, download route, bounded VM bootstrap and baked Instant image. Fresh
Codex hosts select it when trusted forms/URL configuration is enabled. Existing
hosts retain their executable; permissions-only and disabled fresh hosts use stock.
All ACP defaults remain false. Production activation is a separate release step.

## October 5: Sol 6.1 runtime upgrade

The current distribution pairs Codex CLI `0.160.0-sam-c2.2` with ACP adapter
`2.1.1-sam-c2.2` and the official `rust-v0.160.0` Code Mode host. The CLI includes
`gpt-6.1-sol` metadata. SAM's explicit MCP capability, ownership, cancellation,
and URL completion patches remain applied; the profile's model is unchanged.

The immutable archive is 136245837 bytes, SHA-256
`1fd3c07846581888284ed9c9d02bc1f51e3673610c3688d8da98db47030bfb95`.
Its GitHub asset is under `acp-codex-runtime-c2.2-codemode2`. The Ubuntu 22.04
review build is [run 37237755537](https://github.com/raphaeltm/simple-agent-manager/actions/runs/37237755537).
It passed adapter typechecking and all 1,088 adapter tests (33 skipped).
The helper binary signature was verified with Cosign against the exact
`rust-release.yml@refs/tags/rust-v0.160.0` certificate identity and GitHub Actions
OIDC issuer; its upstream legacy bundle signs the extracted binary.
SAM's real Go-to-ACP process tests cover forms and URL interactions in direct
and Code Mode operation, including denial, cancellation, and completion ordering.
These use a local model fixture and do not prove production provider acceptance.

The download endpoint retains the preceding approved digest for existing VM
agents. The new installer verifies the preceding release's catalog, files,
permissions and notices before atomically activating this release; it preserves
previous bytes and a `previous` link. Unknown or modified predecessors fail
closed. Existing running processes retain their executable; verify upgrades with
a fresh session using the newly deployed VM agent or Instant image.

The sections below record the preceding C2.1 rollout and its historical evidence.

## Offline installer

`install-pinned-codex-runtime.sh <archive> <root>` installs only the reviewed
`codemode2` distribution archive (132578703 bytes, SHA-256
`e85e7bfee875bb0bc0397a546073b324258d4cba2c0e54cb3808c3596825b292`). It verifies
an installer-owned private copy before extraction, checks destination ownership
and permissions, serializes activation with a non-truncating lock, verifies the
external catalog and exact seven-file release, checks executable versions and
atomically changes `current`. A different active identity or modified existing
release is rejected. It does not perform migration or rollback.

The installer requires Linux x86_64, Node 22+, glibc/OpenSSL compatible with the
reviewed CLI, Bash, GNU coreutils/tar and util-linux `flock`. It needs write access
to its chosen install root. The production VM install boundary runs as root;
Instant must install during image construction before `USER node`.

`test-install-pinned-codex-runtime.sh <archive>` exercises initial and repeated
installation, unapproved archives, modified catalogs/wrappers, a different
active identity, root symlinks, lock symlinks/hardlinks preserving an unrelated
canary, archive replacement while blocked on a lock, and concurrent installers.
Independent review found and reverified fixes for the input verification race
and truncating lock open. Same-user/root adversaries are outside the filesystem
trust boundary; another user must not control the destination or its ancestors.

## Release gates

Publication, VM bootstrap, image construction, fresh VM automatic selection,
VM form/URL continuation and Instant permission continuation have evidence below.
The final Instant Codex form/URL and fresh-stock rollback results are recorded
in the October 3 final matrix below. These are live runtime/browser results,
separate from image-build verification.
Production activation and stack integration remain pending.

## Licensed distribution archive

The final package is distinct from the earlier manual-test tar. The deterministic
`package-pinned-codex-runtime.sh` verifies private copies of the reviewed build
manifest and the unchanged seven-file runtime catalog. It retains CLI/adapter
licenses, source/build provenance, dependency lockfiles, and the upstream helper
signature under `notices/<identity>` with a separately pinned catalog.

Two independent uncompressed assemblies were byte-identical; deterministic
`gzip -n` produces the publication archive: 132578703 bytes, SHA-256
`e85e7bfee875bb0bc0397a546073b324258d4cba2c0e54cb3808c3596825b292`.
The installer now accepts only this archive and verifies/retains its metadata.
Root-install/unprivileged-execution, tamper rejection, permissions, concurrency,
and interrupted notices publication recovery pass locally.

The explicit `scripts/deploy/publish-codex-runtime-artifact.sh` uses only the
content-addressed R2 key, refuses a differing existing object or ambiguous lookup
failure, and verifies a post-upload readback. Its six scenarios pass with a mocked
R2 CLI. The archive has been published to the experimental GitHub prerelease and its anonymous HTTPS download verified; R2 publication and anonymous Worker download were verified in staging. The download route accepts only the
exact release and Linux amd64; unsupported platforms and absent storage fail
closed. The existing Worker binary streaming helper provides immutable headers.

Publication and runtime verification results are recorded below. They do not
automatically enable production ACP; operational rollback and release disposition
remain explicit gates.

The compressed archive is below pinned Wrangler’s 300 MiB REST upload limit;
the publisher and mocked transport both enforce that bound before upload.

## Opt-in VM bootstrap

Explicit C2 candidate sessions verify the release as the container user on every
start. Missing or invalid files enter the same serialized installation gate as
stock agents; the embedded, reviewed installer downloads only the pinned archive
from the configured control plane and runs as root. Other users cannot replace
its destination or catalog. Instant remains verification-only at runtime.

`CODEX_RUNTIME_INSTALL_TIMEOUT` (default `5m`) includes queue wait, verification,
download and installation. Every Docker exec command also carries a remaining-time
container deadline because killing the Docker client does not stop its child
processes. `CODEX_RUNTIME_INSTALL_KILL_GRACE` (default `5s`) bounds the grace between
TERM and KILL inside the container; processes may persist only for that grace after
the deadline. Abrupt cancellation before the deadline leaves the independent
container deadline in force. A failed bootstrap never falls back to stock while
claiming the patched identity. The shared gate now respects cancellation while
queued. Local tests cover concurrent installation, a stalled verifier/downloader,
a nearly exhausted queue budget, and Instant refusing a missing baked release.

## Instant and clean-install preparation

`make -C packages/vm-agent prepare-container` stages the exact archive and canonical
installer before building the VM binary. The default source is the dedicated
`acp-codex-runtime-c2.1-codemode2` GitHub release asset, always checked against the
fixed SHA and size. `CODEX_RUNTIME_ARCHIVE` allows an offline local archive with
the same identity; it cannot override the accepted digest. No artifact credential
or already-deployed Worker is required for a fresh installation.

The Dockerfile installs in a separate Node22/glibc stage and copies only the
verified runtime tree into the final image before `USER node`. The compressed
archive is not retained in final image layers. Stock binaries remain present;
fresh Codex hosts use the patched runtime when the trusted session-start contract
enables forms or URL requests. Permissions-only and disabled contracts retain stock.
An explicit profile candidate marker remains available for bounded verification. Deployment
publishes that same prepared archive to the stack's R2 before Worker publication,
including first installation and skip-agent deployments.

**Publication verified:** the canonical GitHub prerelease asset is available at
https://github.com/raphaeltm/simple-agent-manager/releases/tag/acp-codex-runtime-c2.1-codemode2 .
Anonymous HTTPS preparation downloaded it and verified the exact size/digest.
Local offline preparation and mocked download/failure checks also pass. Actual
Docker installation and unprivileged verification subsequently passed as recorded below.

## First staging deployment finding

Run `37093512280` passed Pulumi Up, archive preparation, migrations and VM binary
publication, then failed while reading the Pulumi R2-backed state in the new
runtime publication step. That step lacked the two AWS credential mappings
already used by the adjacent VM publication step. The runtime publisher itself
was not reached; API Worker deployment and smoke tests were skipped. Readback
confirmed the prior Worker and all three ACP flags false; staging Environment
ACP overrides were removed. No test compute was provisioned.

The workflow now forwards the same existing R2 credentials for its state lookup.
Independent review passed and all 48 deployment workflow tests passed, including
a regression for the missing credentials and publication ordering. Actual R2
runtime publication and image/runtime verification were checked in the subsequent runs below.

The corrected run `37094388787` published and read-back verified the immutable
R2 archive. An anonymous download through the deployed Worker route matched the
pinned SHA. However, the Instant install stage lacked `libssl.so.3` and its binary
version check failed. Worker publication had already applied the candidate and
flags before Docker failure; root removed the overrides and started rollback
`37095050543`. No test compute was created.

Both Docker stages now explicitly install the CLI's non-glibc shared libraries:
`libssl3`, `liblzma5`, and `libgcc-s1`. Independent dependency review passed. The
actual install stage built locally in Docker, then payload checksums and exact
CLI/adapter versions passed as unprivileged `node`. The reusable
`scripts/ci/verify-codex-runtime-image.sh` also passed locally and now runs in VM
Agent Integration CI, including when the Dockerfile or preparation changes.
Full CI `37095438521` passed on `2233f15c4`, including this image check.
Staging deployment `37096164701` then passed the final image build and smoke tests.

## Fresh VM form verification (2026-10-03)

On staged `2233f15c4`, a fresh compatible VM automatically installed the reviewed
runtime. Both exact versions and payload checksums passed as the workspace user;
no manual archive upload or root installation was used. A real Codex MCP form
reached Cloudflare, rendered in the browser, and received the browser answer.
Cloudflare recorded `delivery_confirmed` / `confirmed`; the fixture accepted it,
and the browser rendered the final `ACP_FORM_CONTINUATION_COMPLETE` response.
The coordinator personally inspected that final screenshot.

The VM, workspace, temporary profile and MCP connection were deleted within the
bounded window. The original staging user's model settings were restored and
compared; the node list and independent D1 fixture queries were empty. All three
staging Environment overrides were removed; rollback run `37098197230` succeeded with smoke tests and all flags read false.
Production was unchanged. URL cases and automatic selection were verified in
the subsequent window below.

## Runtime selection and UI follow-through

The executable is selected once per host from validated session-start interaction
configuration. Enabling forms or URLs on a fresh Codex host selects the reviewed
runtime; changing capabilities on an existing host does not swap its executable.
Explicit profile marker removal/change fails closed independently of automatic
eligibility. A separate selection mutex preserves startup's existing host-lock
contract. Focused race tests cover flags, restart, invalid markers and config.

Untitled form fields now display the schema property name rather than a UUID.
The exact name was chosen over humanization or a generic label to preserve field
meaning. DOM IDs and submitted property keys are unchanged. Unit tests cover
untitled string/array labels and title precedence. Mobile and desktop Playwright
checks passed; the coordinator inspected both screenshots. The changed labels,
inputs and actions are readable, with rubric scores 4/5 for hierarchy, clarity,
mobile usability, accessibility and system consistency. The mobile screenshot is
scrolled to the answer controls; the floating session header remains above them.

- [Mobile form](../../docs/notes/acp-runtime-screenshots/acp-form-empty-mobile-375x667.png)
- [Desktop form](../../docs/notes/acp-runtime-screenshots/acp-form-empty-desktop-1280x800.png)
- [Live VM continuation](../../docs/notes/acp-runtime-screenshots/vm-form-continuation.png)

## Automatic selection, URL completion and Instant permissions (2026-10-03)

Full CI `37098949903` and staging deployment `37099713242` succeeded at
`a460f7fd758b65f8f1a803916a2b229597aa0247`, including final image construction
and smoke tests. A fresh VM profile omitted the explicit candidate marker.
The workspace-user version and checksum checks confirmed automatic selection
of CLI `0.156.1-sam-c2.1` and adapter `1.13.1-sam-c2.1`.

Real Codex URL requests passed both orderings through the browser and Cloudflare:

- Answer first: opening the external page left the interaction pending. Browser
  Continue reached `delivery_confirmed/confirmed` while `urlCompletedAt` remained
  null, including a subsequent check. Completing the controlled external service
  then recorded completion and produced `ACP_URL_CONTINUATION_COMPLETE_SECOND`.
- External completion first: the service notification populated `urlCompletedAt`
  while the human answer remained pending. Browser Continue then confirmed answer
  delivery while preserving completion, followed by `ACP_URL_CONTINUATION_COMPLETE`.

The coordinator personally inspected the final continuation screenshots. Two
other attempts expired unanswered during test-browser setup/loading and were
cancelled/interrupted; those attempts are not counted as successful continuations.
No API answer substituted for the browser. The VM, workspace, profile and MCP
connection were deleted; original user model settings were restored and compared.
Independent D1 checks found no fixture VM/workspace row before Instant started.

The sequential Instant Claude fixture received a browser permission answer and
Cloudflare confirmed delivery. Its initial Python canary failed because Python
was absent in the image. A distinct Node canary was then browser-approved:
interaction `d42aeaf9-5884-4cd2-923d-073ea64e9ec4` reached
`delivery_confirmed/confirmed`, and the persisted assistant transcript contained
`ACP_INSTANT_PERMISSION_COMPLETE`. Desktop/mobile permission screenshots were
personally reviewed. Final-page capture timed out during page loading, so there
is no final Instant screenshot claim. This verifies Claude permissions, not
Instant Codex form/URL execution or a live baked-runtime identity check.

Instant cleanup completed at 06:20 UTC, within the 20-minute cleanup target:
the first stop returned 500 after changing the workspace to stopped; an
idempotent retry returned `workspaceDeleted=true`, workspace GET returned 404,
and the temporary profile was deleted. D1 retains workspace and synthetic node
as deleted tombstones; node runtime termination was confirmed at
`2026-10-03T06:20:19.772Z`. No test VM remains. All three staging Environment
ACP overrides were removed. Rollback `37102710169` succeeded, including smoke tests. All three effective
flags were read false during rollback. Later staging deployments belong to
separate verification work; obtain a new serialized slot before further testing.
Production and the shared Sol profile were unchanged.

## Permission command wrapping

Live Instant screenshots exposed an unbroken command extending beyond its mobile
card. The heading now has a constrained width and wraps anywhere without hiding
permission scope. The exact Node command regression failed before the fix
(heading right edge 433.86px, card right edge 313px at a 375px viewport) and passed
on mobile and desktop after it. Text-range bounds and card bounds are asserted;
web typecheck and changed-file lint passed. The coordinator personally reviewed
both replacement screenshots: full command and answer controls are readable.

## Bounded artifact and executable hardening

The runtime installer resolves Docker once to an absolute path and verifies
binary/ancestor ownership and write permissions before execution. A writable
PATH shadow is rejected before verification or privileged installation. Focused
Go tests pass, including rejection canaries; independent read-only security
review found no actionable issues.

The review-artifact builder now restricts initial/redirected curl protocols to
HTTPS and installs adapter dependencies with `npm ci --ignore-scripts`. Typecheck,
build and nine targeted permission lifecycle tests passed. The resulting adapter
is byte-identical to the reviewed artifact. A broad upstream suite and its
one-worker retry were killed by workspace OOM; neither is reported as passing.
Further local checks use explicit test files, bounded memory and one process at
a time. No Rust rebuild or runtime archive change was required.

## Final Instant matrix and rollback (2026-10-03)

Full CI `37121769606` passed at `e27c4d092`; staging deployments
`37122006482` and `37129245923` passed including smoke tests. The latter ran
with all three explicit ACP overrides true and the matching required runtime.

An external fixture on one staging VM avoided tying the MCP service lifetime
to the Instant client's sleep/restart cycle. In fresh Instant workspace
`01M4149PRFD0WWMBWTKYSZ99AS`, chat `7d091f21-bbc2-4545-a812-0780dcfca1d8`,
actual tool output classified its own parent executable as
`ACP_ACTIVE_RUNTIME=candidate`. No explicit candidate profile marker was used.
The earlier Instant version command reported CLI `0.156.1-sam-c2.1` and adapter
`1.13.1-sam-c2.1`.

- Form `5f99398f-d2b6-4f07-b778-55babb774a73` was answered in the browser.
  Cloudflare recorded `delivery_confirmed/confirmed`; the external MCP service
  recorded acceptance and the same turn emitted `ACP_FORM_CONTINUATION_COMPLETE`.
- URL `62842f67-18f2-478b-9eec-57968de93975` was opened and accepted in the
  browser. Confirmed delivery remained separate from completion for three
  seconds; the controlled external service was then completed in its browser
  tab. Cloudflare recorded `urlCompletedAt=1791039538768`, and the same turn
  emitted `ACP_URL_CONTINUATION_COMPLETE`.
- Both final desktop screenshots were personally reviewed; the URL marker is
  appended to the preceding streamed assistant text, rather than a separate
  exact-text DOM node. Desktop/mobile stress screenshots remain the layout
  evidence for each changed card.

Rollback `37127858726` passed deploy and smoke with all three flags false.
A fresh Instant GPT-5.5 session emitted real tool output
`ACP_ACTIVE_RUNTIME=stock` and the browser final `ACP_STOCK_ROLLBACK_COMPLETE`;
its screenshot was personally reviewed. Stock GPT-6 Sol instead returned
provider HTTP 400, `model 'gpt-6-sol' is not enabled in rustponsesapi`; that
attempt is not a successful rollback turn. Shared Sol was never changed.

Failed attempts are not included in the passes: a co-located MCP fixture
became unreachable across Instant lifecycle transitions; the first external
form hit the fixture SDK's 60-second default timeout (requested at
1791038851034, timeout at 1791038911040). Its browser answer reached Cloudflare
only about 240 ms before that timeout, so confirmed transport did not establish
provider continuation. Subsequent prompts in that timed-out session emitted
no new tool call; the agent reported an unavailable tool despite a healthy
external endpoint, and no underlying cause was proven. A fresh session with
an already-open browser answered the successful form within 2.5 seconds and
completed both interactions in one turn. This is not a claim that an upstream
request can survive a timeout or runtime loss, nor a successful timed-out-session
reconnect test.

Cleanup completed about 15:01 UTC: Instant stop returned workspaceDeleted=true,
GET workspace 404, temporary profile/MCP connection removed, and original user
model settings restored. The external VM node `01M4137KT7075F33BVKZGAMY4P`
was deleted (HTTP 200); workspace deletion returned 404 and GET nodes returned [].
Independent D1 readback found no VM node/workspace row; Instant has a deleted
workspace tombstone. The VM lifetime was under 23 minutes, below the 30-minute
hard cap. All three staging Environment overrides were removed again; final
rollback `37131804167` is running and must pass with effective false readback
before release cleanup is complete. Production is unchanged at this checkpoint.
