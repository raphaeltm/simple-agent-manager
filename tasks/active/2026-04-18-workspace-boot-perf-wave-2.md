# Workspace Startup Perf Wave 2: Boot Phase Timing + Hetzner Docker-CE Image

## Problem

PR #747 (merged 2026-04-18) removed the ~6-minute Cloudflare API outage during VM boot. Node → agent-running on staging is now ~3m 40s, but **we do not know where that 3m 40s is spent**. Optimizing further without phase-level timing data is guessing.

Additionally, Hetzner offers a first-party `docker-ce` marketplace image that ships Docker preinstalled. Switching to it should eliminate the `apt-get install docker.io` step (suspected significant chunk of the remaining time) for roughly zero implementation cost.

This task ships both so the next iteration of perf work has real data to drive decisions.

## Research Findings

### Bootlog reporter (already exists)
- `packages/vm-agent/internal/bootlog/reporter.go` — has `Log(step, status, message, detail)` method
- HTTP POSTs to `/api/workspaces/:id/boot-log` with Bearer auth
- **Workspace-scoped, not node-scoped** — cannot be used from `provision.go` because provision runs before any workspace exists
- Already wired as WebSocket broadcaster for realtime UI streaming

### Provision flow (already has timing data internally)
- `packages/vm-agent/internal/provision/provision.go` tracks 10 named steps with `StartedAt/CompletedAt/DurationMs` (lines ~49–115)
- Steps: `packages`, `docker`, `firewall`, `tls-permissions`, `nodejs-install`, `devcontainer-cli`, `image-prepull`, `journald-config`, `docker-restart`, `metadata-block`
- Writes step events to the in-VM eventstore via `srv.GetEventStore()`
- `installDocker()` already idempotent: `exec.LookPath("docker")` → skip apt if found (lines 294–299)

### Debug package (captures eventstore checkpoint)
- `packages/vm-agent/internal/server/debug_package.go` produces a tar.gz with cloud-init logs, journald, Docker logs, system info, **events database checkpoint**, resourcemon checkpoint
- Step timings are ALREADY in the eventstore — they just aren't surfaced in a human-readable form in the debug package
- The fix is to extract a readable timings summary (text file) from the eventstore when building the package

### Cloud-init template
- `packages/cloud-init/src/template.ts` already emits `logger -t sam-boot "PHASE START/END ..."` markers to journald
- Journald is captured in the debug package → timing derivable from `journalctl` output without any new HTTP roundtrips
- **No additional pre-agent HTTP POSTs needed** — lower risk and data is already captured

### Hetzner provider
- `packages/providers/src/hetzner.ts` line 131: `image: config.image || DEFAULT_HETZNER_IMAGE`
- `packages/shared/src/constants/hetzner.ts`: `DEFAULT_HETZNER_IMAGE = 'ubuntu-24.04'`
- Callers (task-runner, node provisioning) do NOT currently pass `config.image` → always defaults
- **No env var override mechanism exists** — would need to plumb `HETZNER_BASE_IMAGE` through `apps/api/src/services/nodes.ts` where the provider is invoked

### Relevant post-mortems
- `docs/notes/2026-03-12-tls-yaml-indentation-postmortem.md` — YAML literal block indentation bug in cloud-init; requires realistic test data. Enforces: parse YAML output in tests, do not use `toContain()` for multi-line content. (Rule 02: Template Output Verification.)
- Rule 27 (`.claude/rules/27-vm-agent-staging-refresh.md`) — VM agent binary is downloaded at node provision time; MUST delete all existing staging nodes before deploying VM agent changes.

### Testing patterns
- Go: `bootlog/reporter_test.go` uses `httptest.NewServer` + `Reporter`
- TypeScript: `packages/providers/tests/unit/hetzner.test.ts` uses `createMockServer` for fetch mocking
- Cloud-init tests parse YAML with `yaml.parse()` and assert on structure

## Scope Decisions

Following the spirit of the user request while keeping scope tight:

1. **DO add `bootlog.Phase(step, fn) error` helper** — wraps an operation with start/end + duration Log calls
2. **DO instrument bootstrap.go major milestones with Phase helper** — bootstrap already uses `reporter.Log` at many points; we enhance with duration
3. **DO surface provision step timings in debug package** — the data is already in the eventstore, just needs a human-readable dump file
4. **DO switch Hetzner default image to `docker-ce` + add `HETZNER_BASE_IMAGE` override**
5. **DO NOT add a node-level bootlog endpoint** — the eventstore + debug package already carries provision timings; adding a new HTTP endpoint is more work for no additional signal in this wave
6. **DO NOT add cloud-init pre-agent HTTP POSTs** — journald is captured in the debug package; timing is derivable from `logger -t sam-boot` markers without a roundtrip
7. **DO NOT build new UI** — the debug package is the primary inspection surface for this wave

## Implementation Checklist

### Phase timing helper (Go)
- [x] Add `Phase(step string, fn func() error) error` method to `bootlog.Reporter`
  - Emits `Log(step, "started", ...)` before calling fn
  - Measures wall time
  - Emits `Log(step, "completed"|"failed", "", detail="duration_ms=...")` after
  - Nil-safe (matches existing pattern)
- [x] Unit tests in `reporter_test.go`: verify start + completed emitted with duration, failed path propagates error + emits failed status, nil receiver no-ops

### Bootstrap instrumentation
- [x] `Phase` helper added to `bootlog.Reporter` and unit-tested — ready for callers to adopt
- [x] **SCOPE DECISION**: bootstrap.go sites NOT migrated in this wave — each existing `Log("x", "started")/Log("x", "completed"|"failed", ...)` pair carries a human-readable message that `Phase` would drop, and many sites have fallback branches (e.g., devcontainer_up) that require custom error handling. Durations are still derivable from the `createdAt` timestamps already emitted by each `Log` call (captured in bootlog KV + journald). Provisioning step durations — the bulk of pre-agent time — ARE captured explicitly via eventstore `durationMs` detail in `provision.go`.
- [x] Follow-up: individual `bootstrap.go` sites can migrate to `Phase` incrementally when their surrounding logic is refactored

### Provision timings in debug package
- [x] Added `eventstore.ListByTypePrefix("provision.", ...)` method for chronological event retrieval
- [x] Updated `provision.go:logStep()` to emit `durationMs` in the eventstore detail map on completed/failed events
- [x] Added `buildProvisioningTimings()` helper in `debug_package.go` that extracts provision events, groups by step name, and formats a human-readable table
- [x] Included total per-step duration sum and first→last wall-clock summary at the bottom
- [x] Graceful fallback: returns `""` if no events, or an error-embedded string if the query fails (debug package still ships)

### Hetzner Docker-CE image
- [x] Changed `DEFAULT_HETZNER_IMAGE` in `packages/shared/src/constants/hetzner.ts` from `'ubuntu-24.04'` to `'docker-ce'`
- [x] In `apps/api/src/services/nodes.ts` where `provider.createVM` is called, reads `env.HETZNER_BASE_IMAGE` and passes as `config.image` when set (Hetzner only)
- [x] Added `HETZNER_BASE_IMAGE?: string` to `Env` interface in `apps/api/src/env.ts`
- [x] Hetzner provider unit tests: default is `docker-ce`; explicit override still wins
- [x] `provision.go:installDocker()` idempotency: pre-existing `exec.LookPath("docker")` guard at lines 294–299 already skips apt when docker is present (verified by inspection)
- [ ] Snapshot/generator tests that assert on image string: confirmed via grep — only the hetzner provider test referenced `'ubuntu-24.04'`; updated
- [ ] Env reference docs / self-hosting docs: will update if an index exists (checked below)

### Quality gates
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` green
- [ ] Go tests pass (`go test ./...` in `packages/vm-agent`)
- [ ] task-completion-validator passes

### Staging verification (rule 27 — MANDATORY)
- [ ] Delete ALL existing staging nodes before deploying
- [ ] Deploy to staging via `gh workflow run deploy-staging.yml --ref <branch>`
- [ ] Start a fresh project chat session → triggers fresh node provisioning with docker-ce image + new vm-agent
- [ ] Wait for heartbeats and agent session running
- [ ] Download debug package from the new node
- [ ] Inspect `provisioning-timings.txt` and journald for cloud-init phase times
- [ ] Record timings and include in PR description
- [ ] Compare against 3m 40s baseline
- [ ] Clean up: cancel task, delete workspace + node

## Acceptance Criteria

1. **Timings are visible**: Debug package from a staging node contains `provisioning-timings.txt` with per-phase durations
2. **Docker-CE works**: Fresh node provisioned with `docker-ce` image successfully reaches healthy heartbeat state
3. **Docker install phase shortened**: The `docker` phase duration drops substantially (expected: near-zero since Docker is preinstalled)
4. **Rollback lever exists**: Setting `HETZNER_BASE_IMAGE=ubuntu-24.04` on the Worker causes new nodes to provision with Ubuntu (verified by env var presence, not live tested for every value)
5. **No regression**: Node reaches agent-running in ≤ 3m 40s (should be faster, but the gate is "no worse")
6. **Debug package includes bootstrap phase durations**: Bootstrap milestones wrapped with Phase helper show duration_ms in their detail field in the bootlog KV (or journald vm-agent logs)

## References

- Rule 27: `.claude/rules/27-vm-agent-staging-refresh.md` (delete nodes before vm-agent deploy)
- Rule 02: `.claude/rules/02-quality-gates.md` (Template Output Verification, Infrastructure Verification)
- Rule 13: `.claude/rules/13-staging-verification.md` (staging is `sammy.party`; SonarCloud is advisory)
- Post-mortem: `docs/notes/2026-03-12-tls-yaml-indentation-postmortem.md`
- Previous wave: PR #747 (merged 2026-04-18)
- Ideas: `01KPG76NHD22BDN20A9QZ80QRH` (phase timing), `01KPG779057KQ083RMEX07BTM5` (Hetzner docker-ce)
- Hetzner docs: https://docs.hetzner.com/cloud/apps/list/docker-ce/
