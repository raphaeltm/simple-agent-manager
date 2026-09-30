# Remove `Requires=docker.service` from vm-agent systemd unit

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:** PR #733 (`83bdc3e49`, 2026-04-16) removed `Requires=docker.service` from the
>   vm-agent unit, a week before this file was filed. The unit now has only
>   `After=network.target` (`packages/cloud-init/src/template.ts:170-176`), and every node
>   provisioned since uses it. The other `Requires=docker.service` (`template.ts:703`) belongs to
>   `sam-metadata-block.service`, which is meant to be `PartOf=docker.service`.
> - **Still open:** a test in `packages/cloud-init/tests/generate.test.ts` asserting that
>   `vm-agent.service` has no `Requires=docker.service`.

## Problem

The vm-agent systemd unit in the cloud-init template includes `Requires=docker.service`. This means if Docker restarts (e.g., during an update or crash), systemd will also restart the vm-agent. This can kill active agent sessions and cause unexpected disruptions.

## Context

This was identified in PR #735 (now closed as stale). The rest of that PR was superseded by #733/#747, but this fix was never applied to main.

The relevant code is in `packages/cloud-init/src/template.ts` in the systemd unit definition for vm-agent.

## Acceptance Criteria

- [ ] `Requires=docker.service` is removed from the vm-agent systemd unit in `packages/cloud-init/src/template.ts`
- [ ] `After=docker.service` may remain (ordering without hard dependency is fine)
- [ ] Cloud-init template tests updated to verify the change
- [ ] VM agent still starts correctly after Docker is available (verified via unit test or staging)
