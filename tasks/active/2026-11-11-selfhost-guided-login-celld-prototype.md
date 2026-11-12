# Self-host: guided credential login on celld containers (prototype)

Task 01M769WDVM4HCQ7185R8E2QGV6. Branch `sam/prototype-guided-credential-login-e2qgv6`, base `sam/selfhost-pass-2`. Draft only.

## Problem

Raphaël (2026-11-11): Instant sessions stay off on self-hosted installs; guided credential login (subscription sign-in in a Sandbox SDK container: `SandboxDO`, `CredentialSetupSession`, `SetupSessionPool`) must work there. One declaration (`CONTAINER_RUNTIME_AVAILABLE`, `hasContainerRuntime`) gated both. Area B research (idea 01M75V57RG8GR4NA0KC91TM1J7) recommended celld's experimental container support with gVisor and the basic instance type.

## Research findings

- `isGuidedCredentialSetupAvailable` and `services/sandbox.ts` read `hasContainerRuntime`; Instant reads `isContainerWorkspaceRuntimeEnabled` (also `hasContainerRuntime`). A per-class declaration separates them.
- celld 0.6.3 `containers` entries accept class_name, image, name, instance_type, max_instances, runtime; image is built from the Dockerfile's own directory (`deploy.rs resolve_image`).
- celld bind-mounts `<CELLD_WATCH>/container-resolv.conf` by its container-side path, so the data dir must be identical on the host (named volume breaks it).
- celld reaches containers at their bridge address (172.16/12), which SAM's egress fence refuses for uid 7101; celld names the bridge `celld0`.
- celld's own fence (`table inet celld`) refuses container traffic to the node, private ranges and metadata; ICC off.
- Runtime missing: celld errors at once but the Sandbox SDK retries ~150 s, so a deploy-time preflight is the useful guard.

## Checklist

- [x] `SANDBOX_CONTAINER_RUNTIME_AVAILABLE` + `hasSandboxContainerRuntime`; guided setup and sandbox service use it; runtime-tunables baseline entry
- [x] celld config: `containers` for SandboxDO only when `SAM_GUIDED_LOGIN=on` (runtime runsc, instance basic); VmAgentContainer never
- [x] Minimal image build context (`materialiseSandboxImageContext`), refusing symlinks and unsupported COPY forms
- [x] Egress fence: `oifname "celld0"` TCP accept when guided login is on
- [x] Compose override: Docker socket + 1:1 `/var/lib/celld`
- [x] Deploy preflight: Docker daemon and runtime registered
- [x] secrets.env cannot override the runtime declarations
- [x] README section + `.env.example`
- [x] Tests: capability split, generator, fence, settings, image context, preflight
- [x] Live verification on a throwaway VM (Claude and Codex to the provider sign-in step, cancel, expiry, cold load, missing Docker/runsc)

## Acceptance criteria

- [x] Guided login available with Instant unavailable on a celld box (unit tests + live `/config`)
- [x] Claude and Codex sessions surface the provider URL/code in the UI on celld under runsc (live)
- [x] Cancel and TTL expiry destroy the container (live)
- [x] Missing Docker/runtime refused at deploy (unit + live for no daemon)
- [x] Default self-host deploy unchanged: no containers, both declarations false (unit)

## Out of scope / follow-ups (recorded on idea 01M75V57RG8GR4NA0KC91TM1J7)

- Docker-socket hardening (socket proxy or rootless engine) before multi-user use.
- CredentialSetupSession teardown ordering (D1 terminal before slow sandbox I/O; skip scrub when the container never started).
- celld caches image-loaded state; an evicted image breaks starts until restart.

## B4 follow-up (task 01M76JD6SMR9R3RWF436SFBQHJ, 2026-11-12): socket proxy, teardown and fast-fail

Goal: make guided login safe enough for the real test box. Close the security-auditor HIGH (celld held the raw Docker socket), fix the two filed bugs, re-verify on `sam-guided-login-proto`, write the box rollout, then delete the prototype VM.

### Research
- celld 0.6.3 Engine API calls (`crates/celld/container.rs`, `docker.rs`): reap list (label filter), image inspect/load, network get/create/delete (`celld`, `celld-internal`, options icc=false + bridge name), fence container (host net, NET_ADMIN, `CELLD_NFT`), sandbox create/start/inspect/wait/kill/delete, exec create/start (hijack)/inspect, logs. The deploy builds both images on the box, so load is never needed.
- celld's resolver bind source is in its own data dir: a symlink there would let the daemon bind any host file. The proxy rewrites it to an operator-owned file.
- celld gets a new node id on every start and reaps only its own label: a killed celld leaves sandboxes.
- celld reports start failures only via the run's `monitor()` rejection; the SDK's 503 says "the container is not running".

### Checklist
- [x] Docker socket proxy (`deploy/selfhost/docker-proxy/`): exact-shape allowlist, canonical re-serialised bodies, ownership checks by id, exec ids tracked, no load/build/tag/pull, network-less read-only container
- [x] Policy file written by the deploy (`scripts/selfhost/docker-proxy-policy.ts`), images by celld content reference, verified after `celld deploy`; `--init` creates the dir
- [x] Compose override: celld gets only the proxy socket (no docker group, no 1:1 data-dir bind); proxy limits
- [x] Named runtime required (`default` refused)
- [x] Security-auditor HIGH (Object.prototype network names) and LOWs fixed
- [x] Reapers: previous-node sandboxes on celld's reap; sandboxes older than the max session age
- [x] Teardown: D1 terminal first, recovery alarm, scrub skipped for never-started and resumed cleanups, scrub bounded
- [x] Fast-fail: SandboxDO permanent start errors -> `sandbox_runtime_unavailable`
- [x] Live proxy test against a real daemon (34 cases), unit tests, discrimination checks
- [x] Prototype VM re-verification (see PR body)
- [x] README, `.env.example`, PR body "How to enable and test on the box"
- [ ] Delete prototype VM and its network resources (after PR update)

### Acceptance criteria
- [x] A compromised celld cannot start a privileged container, mount host paths, use another image or runtime, or exec into/read/stop another container (live test + attack run on the box)
- [x] Claude and Codex reach the provider sign-in step on the box through the proxy (20.7 s / 19.7 s)
- [x] Cancel destroys the container; interrupted teardown does not block a retry; leftovers are reaped
- [x] Missing runtime says "unavailable" within seconds (1.5 s)
- [x] Egress fence results unchanged; `pnpm selfhost:verify-fence` passes
