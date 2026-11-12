# Deployment nodes whose teardown failed keep callback authority

## Problem

When a deployment node's last environment is deleted, `routes/deployment-environments.ts` sets the
node to `deleting` and calls `deleteNodeResources`. If that fails, the node is set to `error`.

`error` is not in `NODE_CALLBACK_TERMINAL_STATUSES` (`services/node-callback-auth.ts`). So a VM
that is still alive can keep heartbeating, keep refreshing its callback token, and be moved back
to `running` by `/ready`. That means a node SAM tried to remove can return to service.

Ordinary `error` nodes must stay recoverable: heartbeats legitimately revive them. A blanket
addition of `error` to the terminal set is therefore wrong.

## Context

- Found by the security review of `sam/state-machine-defect-fixes` (state-machine audit D5,
  2026-11-10). That PR made `deleting` terminal for callbacks.
- Deferred there as a pre-existing MEDIUM that needs its own design.
- Library report: `/engineering/research/state-machines-2026-11-10/00-state-machine-map.md`.

## Acceptance criteria

- [ ] A deployment node whose deprovision failed cannot refresh its callback token or return to `running`.
- [ ] Ordinary `error` nodes, those not under deletion, still recover through heartbeat and `/ready`.
- [ ] Real-SQL route tests cover both cases, plus a race where the node enters the failed-teardown state after the handler reads it.
- [ ] The cleanup sweep still retries the teardown through the provider API without needing the agent.
