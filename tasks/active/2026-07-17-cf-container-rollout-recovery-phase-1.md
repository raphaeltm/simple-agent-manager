# Cloudflare Container rollout recovery — Phase 1

## Problem

Cloudflare replaces live Instant containers during version rollouts. The current `VmAgentContainer.onStop()` classifies every unexpected `runtime_signal` as terminal, so a healthy task/workspace/session becomes an error even though SAM already has serialized snapshot wake/restore support.

Phase 1 must recover the runtime and current safe snapshot within configurable bounds, preserve durable transcript/partial output, and explicitly mark ambiguous active work as interrupted for manual retry. It must never blindly replay a prompt. The polished recovery UI is deferred.

## Research findings

- `apps/api/src/durable-objects/vm-agent-container.ts` persists launch configuration and serializes sleeping wake/restore, but only `sleeping` is wakeable and `runtime_signal` is terminal.
- Fresh wake already mints node, workspace, and management credentials and vm-agent restore refreshes project runtime assets.
- `packages/vm-agent/main.go` handles SIGTERM by terminally stopping sessions before reporters flush; standalone shutdown needs a separate idempotent drain/checkpoint path.
- `packages/vm-agent/internal/server/session_snapshot.go` already creates atomic manifest-backed WIP/HOME snapshots and supports transcript-only degradation.
- Active-work DO state identifies the active agent session and can provide a durable, single manual-retry disposition without prompt replay.
- Recovery must keep errors sanitized and bound attempts/timeouts through environment configuration.

## Implementation checklist

- [ ] Add a persisted recoverable replacement lifecycle/diagnostic record with bounded attempts.
- [ ] Classify `runtime_signal` as replacement while preserving intentional stop, idle sleep, and crash semantics.
- [ ] Allow replacement state through the existing serialized wake/restore critical section and mint fresh control-plane credentials/assets.
- [ ] Persist one explicit interrupted/manual-retry active-prompt disposition while retaining transcript/output.
- [ ] Add idempotent, deadline-bounded standalone SIGTERM drain that checkpoints before reporter/server shutdown.
- [ ] Expose sanitized degraded diagnostics without credentials, prompt bodies, paths, or raw upstream errors.
- [ ] Add discriminating TypeScript and Go unit/integration tests for replacement, stop, crash, concurrency, bounds, drain, and prompt disposition.
- [ ] Document new configuration and lifecycle behavior where canonical references require it.
- [ ] Run all requested specialist reviews and task-completion validation.

## Acceptance criteria

- [ ] `runtime_signal` alone does not terminally error the node, workspace, session, or task.
- [ ] Repeated/concurrent replacement handling launches at most one bounded restore and stops after the configured attempt limit.
- [ ] A fresh replacement restores current control-plane assets/credentials and verified WIP when available.
- [ ] Snapshot failure degrades to transcript continuity with sanitized diagnostics.
- [ ] An active prompt receives exactly one durable `interrupted_manual_retry` disposition and is not replayed.
- [ ] Intentional stop remains stopped and application exit/crash remains terminal.
- [ ] SIGTERM drain is idempotent, attempts checkpointing, flushes reporters, and respects its configured deadline.
- [ ] TypeScript and Go tests cover the lifecycle matrix and cross-boundary recovery behavior.
- [ ] No polished web recovery UI is added.
- [ ] Real active-work replacement passes on shared staging after a staging lease is granted.

## Constraints and references

- SAM idea `01KXNJ87157H901TAM2WY5E22B`.
- `tasks/backlog/2026-07-12-cf-container-wake-restore-hardening.md`.
- `.claude/rules/14-do-workflow-persistence.md`, `35-vertical-slice-testing.md`, and the project constitution.
- Do not deploy to shared staging or merge until the parent workflow coordinator grants the staging lease.
