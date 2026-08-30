# VM agent cgroup resource isolation

## Problem

Container workloads can exhaust node memory and cause the kernel OOM killer to
terminate the host `vm-agent`. The vm-agent is the control-plane heartbeat and
workspace lifecycle boundary, so it needs stronger host-level protection than
ordinary containers.

## Research findings

- `packages/cloud-init/src/template.ts` writes `vm-agent.service`, Docker daemon
  configuration, firewall scripts, swap settings, and supporting systemd units
  through cloud-init `write_files`.
- `packages/cloud-init/src/generate.ts` owns template variables, defaults, and
  validation before values are embedded into YAML, shell, JSON, or systemd
  contexts.
- `apps/api/src/services/nodes.ts` is the deployed provisioning boundary that
  passes Worker environment values into `generateCloudInit()`.
- Docker's memory ceiling can be derived directly on the VM from
  `/proc/meminfo`, avoiding cloud/provider size mappings in cloud-init while
  still scaling with the selected VM's actual memory.
- Hetzner's default `docker-ce` base image may already have `docker.service`
  installed and running before `vm-agent` starts, so the drop-in must be paired
  with a guarded `systemctl daemon-reload` and Docker restart when the unit is
  present. Plain Ubuntu-style images still get the pre-created drop-in before
  Docker's first start.
- `.claude/rules/06-vm-agent-patterns.md` requires scalar `runcmd` entries to be
  `/bin/sh`/Dash-compatible; changed command blocks must be parsed from rendered
  YAML and executed under their declared interpreter.
- Retained TLS/cloud-init lesson
  `tasks/archive/2026-03-12-fix-tls-yaml-indentation-and-process.md`: tests must
  parse generated YAML and use realistic multi-line content because string
  containment missed a production-breaking cloud-init indentation bug.
- `tasks/archive/2026-06-01-cloud-init-validation-hardening.md` confirms the
  existing test style should be extended: validate env-fed template values before
  rendering and parse output structurally.

## Implementation checklist

- [x] Add `OOMScoreAdjust=-900` and `Slice=sam-infra.slice` to the vm-agent
      systemd service `[Service]` section.
- [x] Add a `sam-infra.slice` systemd unit with `MemoryMin=384M`.
- [x] Add Docker memory-limit drop-in generation at
      `/etc/systemd/system/docker.service.d/resource-limits.conf`.
- [x] Add `DEFAULT_VM_AGENT_MEMORY_RESERVE_MB = 768` and env/variable validation
      for the configurable reserve.
- [x] Derive Docker `MemoryMax` from concrete total memory minus reserve without
      hardcoding VM sizes in the cloud-init template.
- [x] Apply the Docker systemd drop-in before `vm-agent` starts, restarting
      Docker when the service unit already exists.
- [x] Document and sync the `VM_AGENT_MEMORY_RESERVE_MB` Worker runtime
      configuration variable.
- [x] Preserve the existing 2GB swap and swappiness behavior.
- [x] Add parsed-YAML tests for vm-agent service OOM score and slice assignment.
- [x] Add parsed-YAML tests for `sam-infra.slice` contents.
- [x] Add parsed-YAML and runtime shell tests for Docker `MemoryMax` calculation
      across small/medium/large-sized memory inputs with realistic multi-line
      cloud-init content.
- [x] Add provisioning-boundary coverage showing Worker env reaches
      `generateCloudInit()`.
- [x] Run focused tests and package validation.

## Acceptance criteria

- Generated cloud-init YAML contains `OOMScoreAdjust=-900` in `vm-agent.service`.
- Generated cloud-init YAML contains `Slice=sam-infra.slice` in
  `vm-agent.service`.
- Generated cloud-init YAML creates `sam-infra.slice` with `MemoryMin=384M`.
- Docker's systemd drop-in sets `MemoryMax` to total memory minus configured
  reserve.
- Default reserve is 768MB and can be overridden via environment/config.
- Memory calculations scale for small, medium, and large VM memory profiles.
- Existing swap file size and swappiness behavior is unchanged.
- New or changed runcmd content is POSIX-compatible and tested under `/bin/sh`.

## Validation evidence

- `pnpm --filter @simple-agent-manager/cloud-init typecheck && pnpm --filter @simple-agent-manager/cloud-init lint && pnpm --filter @simple-agent-manager/cloud-init test`
  - Passed after the final runcmd/test changes.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/provision-node-rethrow.test.ts`
  - Passed with `VM_AGENT_MEMORY_RESERVE_MB` forwarded into `generateCloudInit()`.
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build`
  - Passed on the final patch set.
- GitHub Actions staging deploy:
  - `https://github.com/raphaeltm/simple-agent-manager/actions/runs/33306385103`
  - Completed successfully: config validation, Cloudflare deploy, and smoke
    tests passed.
- Live staging verification on a freshly provisioned small Hetzner node:
  - Node `01M1952BPG939BP4E9M7HBDT11` reached `running/healthy` with a fresh
    heartbeat and metrics.
  - Boot logs showed `PHASE START: resource-isolation` before
    `PHASE START: vm-agent-start`.
  - Boot logs showed Docker limit derivation from actual VM memory:
    `MemoryMax=3053M (total=3821M reserve=768M)`.
  - Systemd status showed `vm-agent.service` running in
    `/sam.slice/sam-infra.slice/vm-agent.service`.
  - Systemd status showed Docker using drop-in
    `/etc/systemd/system/docker.service.d/resource-limits.conf` with a
    memory max around 2.9GiB.
  - Boot logs confirmed existing swap behavior was unchanged:
    `Configuring 2048MB swap file` and `Swap configured: 2048MB,
    swappiness=60`.
- Live workspace smoke on the same node:
  - Workspace `01M195ER8MV3E44JBGHABSRBVR` reached `running`.
  - Browser verification loaded the node page and observed live log streaming
    with zero unexpected console errors.
- Staging smoke/observability checks:
  - Live Playwright smoke: 11 passed, 1 flaky test passed on retry; the flaky Amp
    smoke was rerun separately and passed.
  - `pnpm quality:observability-noise` passed; D1 observability was skipped
    because `OBSERVABILITY_DB_ID` is not configured in this environment, and
    Workers telemetry was unavailable with 403.
- Cleanup:
  - Deleted temporary workspace `01M195ER8MV3E44JBGHABSRBVR` and node
    `01M1952BPG939BP4E9M7HBDT11`; subsequent GET requests returned 404 for both.

## Review evidence

- `test-engineer`: PASS — generated YAML is parsed structurally, the Docker
  configurator is executed under `/bin/sh`, memory sizing covers small, medium,
  large, and custom reserve cases, and provisioning env wiring is covered.
- `constitution-validator`: PASS — the reserve uses a `DEFAULT_` constant plus
  env wiring/validation, and Docker limits derive from `/proc/meminfo` rather
  than hardcoded VM sizes.
- `env-validator`: PASS — `VM_AGENT_MEMORY_RESERVE_MB` is synchronized across
  Worker Env typing, provisioning, Wrangler vars, `.env.example`, deployment
  sync allowlist, public docs, and env-reference.
- `doc-sync-validator`: PASS — public configuration docs now describe the new
  optional cloud VM resource-isolation variable.
- `cloudflare-specialist`: PASS — the Wrangler change is a non-sensitive
  `[vars]` default with no Cloudflare binding, secret, D1, KV, or R2 changes.
- `task-completion-validator`: PASS — task checklist, acceptance criteria, diff,
  tests, and branch base were cross-checked before PR creation.
