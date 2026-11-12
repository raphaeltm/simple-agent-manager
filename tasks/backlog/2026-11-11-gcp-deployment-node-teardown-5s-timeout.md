# Stopping a GCP deployment environment fails: node teardown has a 5 s budget

## Problem

Stopping a deployment environment whose node is a GCP VM fails on the first attempt:
`Stop failed during managed node teardown: The operation was aborted due to timeout`.
The environment goes to `error`, and `start` is then refused because it is "still linked
to a node". The node is left `destroying` with an hour of `cleanup_backoff_until`.

`cleanupDeploymentNode` (`apps/api/src/services/deployment-node-cleanup.ts`) runs
`deleteNodeResourcesStrict` under `AbortSignal.timeout(requestTimeoutMs)`. The env stop path
(`cleanupDeploymentNodeIfUnassigned` in `routes/deployment-environment-lifecycle.ts`)
and the scheduled sweep (`scheduled/deployment-node-cleanup.ts`) both pass
`stoppedHandoffRequestTimeoutMs`. Its default is `DEFAULT_NODE_STOPPED_HANDOFF_REQUEST_TIMEOUT_MS = 5_000`
(`packages/shared/src/constants/node-pooling.ts`). A strict GCP instance delete has to wait
for the provider's delete operation to finish before it has termination proof, and that
usually takes much longer than 5 s.

A retry made once GCP had finished the delete completed: a `DELETE` on the environment 90 s
later recorded `runtime_termination_confirmed_at` and deleted the DNS record. So the first stop
fails reliably and is recovered only by a manual retry, or by the sweep an hour later.

## Context

Found 2026-11-11 while verifying PR #2627 (D7) on staging. Environment
`01M75VC6AZRJR27DSBNW0KME2S` in project `01KWHD8XS7MQ7R6KWXJYRHDVH4`; node
`01M75VDHC45ECFD6YSFJCZ9ARC` (GCP, `europe-west1-b`, small). The release applied
(`observed=applied`, `seq=1`), then the stop failed 6 s after the claim. Decision row:
`destroy_failed` / `The operation was aborted due to timeout` / `deployment_teardown`.
PR #2627 does not touch teardown, strict deletion or providers.

## Acceptance Criteria

- [ ] Stopping a GCP-placed deployment environment completes (or hands off to a sweep that
      completes) without leaving the env in `error`
- [ ] The teardown budget is sized from the provider's real delete latency (rule 81: state the
      worst case), and stays resumable: a retry recognises an already-submitted delete
- [ ] A test drives a provider whose delete takes longer than one request budget, and asserts
      the node is eventually confirmed deleted and the env can be started again
- [ ] An env left in `error` by a failed teardown has a documented recovery path
