# L22: self-host core packaging (land from sam/selfhost-pass-2 in 3 PRs)

Task `01M7RPE328YRAM3RBA67Q3Z8N0`. Landing plan: idea `01M72M9AEB933ZY8269D376DKC` (part 6, row L22).
Coordination channel: `feature.selfhost-landing`. Integration tip at start: `2f61cea9a`.

## Problem

The self-host (celld, single VM) packaging lives only on the integration branch. L22 lands its core
on main in three PRs, each cut from main with `git restore --source=origin/sam/selfhost-pass-2`
and trimmed. Nothing in L22 may change Cloudflare behaviour.

## Research findings

- `scripts/selfhost/deploy.ts` imports the egress fence (L23), key agent / sealed secrets (held),
  guided login and docker-proxy (held). The L22 copy must drop those and run legacy-plaintext only.
- `upgrade.ts` imports `backup-cli` (L24). L22's upgrade has no automatic backup step.
- The hosted-git "local backend" (`services/hosted-git/local-backend.ts`) is the HostedGitRepo
  Durable Object (D7, held), so no L22 PR adds `isLocalHostedGitActive` to Worker files (M4 HIGH-4).
- `durable-objects/sandbox-do.ts` exists for guided-login containers only (held), so main's
  `index.ts` keeps exporting the SDK `Sandbox` (M4 HIGH-1).
- `SELFHOST_DURABLE_OBJECTS` holds only HostedGitRepo, so the L22 celld entry mounts no
  self-host-only class or route, and `apps/api/src/app.ts` is not needed.
- F25 (GET /api/credentials/agent hung 300 s on a cold isolate) is the shared-flight join
  problem: celld drops a request's ops when its client disconnects, and a per-isolate shared
  promise then never settles. The fix is Worker-loaded (`packages/worker-core/src/shared-flight.ts`
  and its call sites), so it gets its own staging-verified PR.
- F21 Caddy items (PR #2625 security notes L1, L4, L5, L6, L7): double-encoding, `port_range_cooling_down`
  transient classification, .env-only port check, broad 404 matcher, Login rate limit on `/~!frp`.
- F11 (#2666): image build runs unfenced on every compose build.
- M5 carry-over: an `s3://` operator store needs `R2_S3_REGION`; the operator docs must say so.
- D9: the Docker live suite runs only on self-host paths in CI, not on the cloud-init filter.

## PR split

### PR 1 (L22a): shared-flight joins for celld (F25), Worker-loaded

- [x] `packages/worker-core/src/shared-flight.ts` + `apps/api/src/lib/shared-flight.ts` re-export
- [x] Bounded joins: admin-settings-cache, admin-settings-resolution, llm-endpoint-snapshot,
      platform-config-core, project-data `compact-r2`; reviewed allow markers in range-report
- [x] Unrelated OAuth `validStoredValue` hunk trimmed out
- [x] `pnpm quality:shared-flight-joins` check + tests, wired into CI and ast-checks scope
- [x] Discrimination, one surgical revert per site, each turning only its own cases red:
      platform-config-core (main), AdminSettingsCache and LLM snapshot (plain await), the
      platform-config attempt cap (raised to 99), compact-r2 (main: the celld own-timer test)
- [x] Full lint / typecheck / test (41/41 tasks; API 17,686 passed)
- [x] Reviews: security-auditor PASS, architecture-reviewer ADDRESSED, cloudflare-specialist PASS,
      task-completion-validator ADDRESSED
- [x] Deferred MEDIUM (rule 42): compact-r2 does not evict an abandoned R2 operation on celld,
      tracked in tasks/backlog/2026-11-19-compact-r2-celld-abandoned-op-eviction.md
- [x] Staging smoke on staging2 (primary held; no VM needed): settings, platform config, agent
      credential path, 24-request parallel join burst, all 200; no new error groups
- [x] Merged #2901 as c44ec1576 (Deploy Production: see PR 2 body)

### PR 2 (L22b): celld build and deploy core (self-host only)

- [x] celld-binary, celld-config (trimmed: no containers), celld-project (plain entry only), celld-adopt
- [x] deploy (plaintext only), deploy-steps, deploy-harness, box-settings, mail/inbound-mail settings,
      secret-files, versions, vm-agent-artifacts. Dropped: install-record (only teardown/backup read
      it), platform-probe (only key-choice used it)
- [x] create-account (with the #2888 F13c owner guard, `--secrets`, fail-closed `--superadmin`) + account-sql
- [x] upgrade + upgrade-lib without the L24 backup step; forwards env file, state dir and secrets
- [x] `apps/api/src/selfhost/build.ts` (celld entry only) + import-graph test (Cloudflare entry
      must not reach apps/api/src/selfhost/ or scripts/)
- [x] `selfhost:*` scripts (deploy, create-account, test, upgrade), scripts/selfhost tsconfig and
      vitest config, unit tests + tsc in CI "Validate Deploy Scripts"
- [x] Review fixes: security H1 (upgrade forwarding + no key minting over a prior deploy), M1 atomic
      platform-keys write, M2 deploy/selfhost/.gitignore, M3 create-account --secrets; architecture
      MEDIUMs (go.mod filter, scripts/ in boundary test, reverse-tunnel limits shared from the Worker)
- [x] task-completion-validator PASS (MEDIUM fixed), CI, CodeRabbit (9 threads fixed), merged #2902
      as fa04695d2, Deploy Production 44478774764 success

### PR 3 (L22c): box runtime (self-host only), #2906

- [x] deploy/selfhost compose (no key-agent, fence, docker-proxy, metadata-proxy), Caddy with the
      F21 fixes (L1 double-encoding, L5 ports as compose runs them, L6 narrow 404, L7 frp Login
      limit), frps, objectstore, .env.example, gcp-bootstrap.sh
- [x] F11: builds are explicit and change-gated. Upgrade builds only the local images whose build
      inputs changed, then `up -d` without `--build` (`image-rebuilds.ts`). Both images pin base
      images by digest and modules by checksum. Build steps keep the box's unrestricted egress
      (metadata server included), as the runtime does, because the egress fence (L23) is held;
      the README says so.
- [x] Docker live tests + CI job on self-host paths only (D9)
- [x] Operator README marked experimental, including R2_S3_REGION for s3://
- [x] Rebased onto main after #2902 (upgrade retry/box-scoped compose kept, F11 merged in)
- [x] Review fixes:
  - Architecture: CI filters, no build in Validate Deploy Scripts, live harness dedup,
    gcp-bootstrap pinned to GCP_REQUIRED_APIS / SA_PROJECT_ROLES, loadBoxEnv.
  - Security MEDIUMs: shared-pool refusal, celld/frps with no caps and read-only, 24-char
    objectstore secret, sam-mx port reserved plus a deploy-time port check.
  - Security LOWs: site-level X-SAM-* strip, child env allowlist, build-arg README note.
  - Codex P2s: shell precedence for every compose variable; SAM_MX_LISTEN must be host:port.
  - SonarCloud: live-suite TLS verification, `--ignore-scripts`, non-root Caddy plus the
    caddy-volumes ownership hand-off, smells.
  - Secret Scan: reviewed-baseline entry for the synthetic deploy-harness fixture.
- [ ] Security HIGH (gcp-bootstrap pool/* binding admits a user credential naming the pool; same
      shape in main's guided setup): Worker fix is SAM task 01M7SB8FRZ08M5NEX9WGM74X61 / PR #2905.
      Coordinator: do not merge PR 3 until #2905 is deployed, then re-run security-auditor.
- [x] BOX round R18 (fresh teardown + README rebuild from c4fac57ca, upgrade to 795bf674f):
  - Passed: install, admin by email, GCP reverse-tunnel node heartbeat through frps, the 0255
    lease table on fresh D1, and an upgrade that rebuilt only Caddy. Evidence is in the #2906
    body.
  - README findings fixed in 754d86cde.
- [x] Owed, as agreed by the coordinator on 2026-11-19:
  - Agent session on a box: owed to the first slice that gives a box a repository source
    (hosted git). Main plus L22 cannot create a project: artifacts is disabled and there is no
    GitHub/GitLab app.
  - L19 celld guided-login teardown: no gVisor; guided login is held.
  - L13 metered ceiling: the box has no platform AI key.
- [x] task-completion-validator: the agent-session gap is recorded as owed (above) and the HIGH
      is blocked on #2905. The live suite passed locally at 795bf674f (6 files, 208 tests); CI
      `Self-host Live (Docker)` runs on every head.
- [ ] CI green, merge after #2905 deploys plus a security re-review, Deploy Production

Not fixed here (accepted as tracked by the coordinator):
- F21 L4 `port_range_cooling_down` is fail-fast in `apps/api/src/selfhost/reverse-tunnel/leases.ts`
  and in the shared Worker failure path; idea 01M7MK0PCF032CT45Z45HRSDEQ.
- Security LOWs: access-log redaction matches literal path spellings only, and the frp Login limit
  is per address (IPv6 rotation).
- Worker defects seen again on the BOX, all outside L22's scope and reported to the coordinator:
  - `DEFAULT_VM_LOCATION` nbg1 on GCP-only installs.
  - A 60-minute price backoff after a transient first failure.
  - JWT kid `key-1970-01`.
  - A node shows healthy before its first heartbeat.

## Acceptance criteria

- Cloudflare Worker import graph unchanged by PRs 2-3; Worker behaviour unchanged except the
  bounded joins in PR 1.
- A box installed from main alone deploys, serves the app, creates an admin by email, runs one
  agent session and heartbeats a reverse-tunnel node. (The agent session is OWED to the hosted-git
  slice, per the coordinator on 2026-11-19; every other part was proven in BOX round R18.)
