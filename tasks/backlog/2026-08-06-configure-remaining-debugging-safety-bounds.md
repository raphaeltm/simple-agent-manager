# Configure Remaining Debugging Safety Bounds

## Problem Statement

PR #1750 exposes the operational incident, quota, retention, redaction, database-contention,
and persisted-field bounds introduced by the same-instance debugging pipeline. A constitution
review found four lower-risk implementation safety caps that remain compile-time constants:
the diagnostic upload response preview, locally persisted delivery-error text, snapshot
collector concurrency, and browser diagnosis-event pagination. These are intentionally deferred
because changing their configuration surfaces is independent of the release-blocking durable
delivery path and needs coordinated Worker, VM Agent, cloud-init, and web build-time contracts.

## Implementation Checklist

- [ ] Add a validated VM Agent setting for the maximum diagnostic upload response bytes instead of the `4096` reader limit.
- [ ] Add a validated VM Agent setting for the locally persisted delivery-error length instead of the `512` character cap.
- [ ] Add a validated VM Agent setting for snapshot collector concurrency instead of the fixed single collector.
- [ ] Add a documented web build-time override for diagnosis-event pagination instead of the fixed 100-page safety cap.
- [ ] Thread VM Agent settings from generated deployment configuration through cloud-init and systemd.
- [ ] Add default/override/invalid-value tests and keep all loops and reads bounded.
- [ ] Synchronize `.env.example`, `apps/api/.env.example`, env reference, and public configuration docs.

## Acceptance Criteria

- [ ] Operators can tune all four safety bounds without rebuilding SAM or the VM Agent.
- [ ] Defaults preserve the existing bounded behavior.
- [ ] Invalid, zero, and negative values fail validation or use a documented safe fallback.
- [ ] Generated deployments propagate each VM setting to freshly provisioned nodes.

## Evidence

- Constitution review of PR #1750 on 2026-08-06 classified these four findings as Medium.
- `packages/vm-agent/internal/errorreport/reporter.go` bounds response reads at 4096 bytes.
- `packages/vm-agent/internal/errorreport/store.go` bounds stored delivery errors at 512 characters.
- `packages/vm-agent/internal/errorreport/reporter.go` creates a collector semaphore with capacity 1.
- `packages/shared/src/constants/ai-services.ts` defaults diagnosis-event traversal to 100 pages without an override.
