# Refresh model harnesses and ACP wrappers

## Problem
The September 23 model catalog refresh shipped without runtime upgrades. Production rejects Claude Code 2.1.257; new models require >=2.1.280.

## Research
- Deployed main 6946a1454 pins Claude ACP 0.73.0, whose published SDK dependency is 0.3.257; companion CLI 2.1.260 is separately installed.
- gateway.go only checks companion CLI >=2.1.251, allowing stale adapters in reused workspaces. Both Docker and standalone installers share this check.
- Install manifest, Go installer, Instant Dockerfile and sandbox CLI Dockerfile must stay synchronized; existing manifest and runtime contract gates cover alignment.
- Registry checked September 24: Claude ACP 0.81.2 embeds SDK 0.3.280; Claude CLI 2.1.281; Codex ACP 1.13.1 with Codex 0.156.1; Gemini 0.61.0; Vibe 2.25.8; OpenCode 1.18.32; Amp CLI 0.0.1790261352-g2ab14a. Amp ACP remains 0.1.3.

## Checklist
- [ ] Synchronize supported harness and wrapper pins across install surfaces.
- [ ] Require current Claude adapter and compatible companion CLI on startup; preserve no-Node bootstrap validation.
- [ ] Execute shell regression tests for stale adapter/current CLI, stale CLI/current adapter, supported pair, malformed/missing versions and OAuth/API-key paths.
- [ ] Verify real installed adapter/embedded SDK versions and ACP initialization.
- [ ] Update mock runtime and document catalog/runtime update coupling.
- [ ] Run local validation and independent specialist/completion reviews.
- [ ] Coordinate staging; deploy and verify fresh VM heartbeat, workspace and Claude model prompt, then clean up.
- [ ] Green CI and resolved CodeRabbit state; merge and monitor production.

## Acceptance criteria
New and reused runtimes install compatible Claude SDK and CLI; a stale adapter cannot pass merely because its separate CLI is new. All install pins pass synchronization checks. Runtime smoke tests and CI pass; deployment succeeds.

## References
packages/shared/src/agent-install-manifest.json; packages/vm-agent/internal/acp/gateway.go; apps/api/Dockerfile.vm-agent-container; apps/api/Dockerfile.sandbox; rules 27 and 54; /do workflow.
