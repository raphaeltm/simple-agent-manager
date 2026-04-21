# Fix Teardown Stack Removal Guard

## Problem

The production teardown workflow can remove Pulumi stack state even when `pulumi destroy` fails. That leaves Cloudflare resources orphaned and causes the next deploy to create a fresh stack that collides with existing resource names, such as the KV namespace `sam-prod-sessions`.

## Research Findings

- `.github/workflows/teardown.yml` runs `Pulumi Destroy` with `continue-on-error: true`.
- `.github/workflows/teardown.yml` previously gated `Remove Pulumi Stack` only on `steps.pulumi_stack.outputs.status == 'ok'`, not on the destroy result.
- `infra/resources/kv.ts` creates the KV namespace title from `${prefix}-${stack}-sessions`, so a deleted Pulumi stack plus retained Cloudflare namespace produces Cloudflare error `10014`.
- Documentation search found no user-facing teardown guide describing this exact stack-removal behavior.

## Checklist

- [x] Update teardown workflow so `pulumi stack rm` runs only after `pulumi destroy` reports `deleted`.
- [x] Add a regression test for the workflow guard.
- [x] Add bug postmortem.
- [x] Add process rule for destructive cleanup state gates.
- [x] Run focused quality test.
- [x] Run lint and typecheck.
- [ ] Open PR.

## Acceptance Criteria

- A failed `pulumi destroy` leaves the Pulumi stack state available for retry/reconciliation.
- The regression test fails if `Remove Pulumi Stack` is no longer gated on successful Pulumi destroy.
- PR includes preflight, postmortem, and validation evidence.
