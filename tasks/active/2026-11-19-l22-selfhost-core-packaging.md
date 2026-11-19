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
- [x] Discrimination: platform-config-core reverted to main turns exactly the two platform-config
      abandonment tests red (Cloudflare and celld join modes)
- [ ] Full lint / typecheck / test / build
- [ ] Reviews: security-auditor, architecture-reviewer, cloudflare-specialist, task-completion-validator
- [ ] Staging smoke on primary (settings, platform config, agent credential path)
- [ ] Merge, Deploy Production success

### PR 2 (L22b): celld build and deploy core (self-host only)

- [ ] celld-binary, celld-config (trimmed), celld-project (plain entry only), celld-adopt
- [ ] deploy, deploy-steps, deploy-harness, box-settings, mail/inbound-mail settings,
      install-record, secret-files, versions, vm-agent-artifacts, platform-probe
- [ ] create-account (with the #2888 F13c owner guard) + account-sql
- [ ] upgrade + upgrade-lib without the L24 backup step
- [ ] `apps/api/src/selfhost/build.ts` (celld entry only) + import-graph test
- [ ] `selfhost:*` scripts, scripts/selfhost tsconfig and vitest config, unit tests in CI

### PR 3 (L22c): box runtime (self-host only)

- [ ] deploy/selfhost compose (no key-agent, fence, docker-proxy, metadata-proxy), Caddy with the
      F21 fixes, frps, celld/start.sh, objectstore, .env.example, gcp-bootstrap.sh
- [ ] F11 fix
- [ ] Docker live tests + CI job on self-host paths only (D9)
- [ ] Operator README marked experimental, including R2_S3_REGION for s3://
- [ ] BOX: fresh teardown + rebuild from this head; prove 0255 lease table on a fresh box;
      L19 celld teardown OWED (guided login not installed); L13 metered ceiling only if a platform
      AI key exists

## Acceptance criteria

- Cloudflare Worker import graph unchanged by PRs 2-3; Worker behaviour unchanged except the
  bounded joins in PR 1.
- A box installed from main alone deploys, serves the app, creates an admin by email, runs one
  agent session and heartbeats a reverse-tunnel node.
