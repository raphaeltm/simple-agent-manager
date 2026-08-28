# Add SAM lifecycle event producers

SAM task: `01M1456R5Y0RPM40GDPCYQ7FCK`
Parent task: `01M1450K5MW05BES9H5CYEX3ZP`
Output branch: `sam/wave-c2-add-deploymenttasksession-yq7fck`
PR target: `sam/weve-previously-talked-eventing-y207hp`
Draft PR: https://github.com/raphaeltm/simple-agent-manager/pull/1961
Base: `sam/wave-b4-reconcile-integrate-nbmzfm`

## Constraints

- Do not deploy to, mutate, or validate staging.
- Preserve B4 event contracts: ProjectData is project-scoped source of truth; admission and delivery remain separate.
- Persist bounded metadata/display only; no raw lifecycle payloads.
- Emit state-transition events, not polling metrics.
- Include idempotent delivery keys and payload fingerprints.
- Do not implement runtime injection, GitHub producers, public UI inspector, staging behavior, deployment controls, or destructive lifecycle behavior.
- Do not depend on unmerged C1/C3 branches.

## Findings

- ProjectData event admission already provides `(project_id, source, delivery_key)` idempotency plus fingerprint conflict detection.
- ProjectData session lifecycle methods are already project-bound in the service/DO boundary and have clear transition boundaries for create, sleep, wake, stop/archive, and fail. Emission should live in the service wrapper to avoid importing the ProjectData service back into the DO module.
- Task lifecycle transition boundaries are split across TaskRunner start/fail, shared terminal transitions, workspace callbacks, user status routes, conversation close, MCP `complete_task`, and queued-start failure handling.
- Deployment lifecycle transition boundaries with clear project ids exist for release creation, release apply claims, heartbeat reconciliation of release/environment state, publish job creation/status callbacks, and environment start/stop. Environment create/delete and node lifecycle surfaces are intentionally deferred unless directly needed by the first subscription consumers.
- High-frequency callback/log streams should not emit SAM lifecycle events unless the durable state changes.

## Implementation checklist

- [x] Add normalized lifecycle event builders and best-effort ProjectData producer helpers.
- [x] Wire task started/completed/failed/cancelled producer paths only after successful status transitions.
- [x] Wire ProjectData session lifecycle producers through the ProjectData service wrapper.
- [x] Wire deployment release, publish job, and environment lifecycle producers at project-scoped transition boundaries.
- [x] Add focused tests for producer paths and duplicate replay/idempotency.
- [x] Run api/shared typecheck/lint/build/test gates proportional to the diff.
- [x] Run specialist reviews and archive only after task-completion validation.
- [x] Push branch, open draft PR, and check PR CI.

## PR

- Draft PR: https://github.com/raphaeltm/simple-agent-manager/pull/1961
- CI was checked after push; final status is tracked in the PR.

## Deferred by scope

- Runtime steering/injection.
- GitHub event producers.
- Public UI event inspector.
- Staging validation or deployment.
- Environment create/delete producers.
- General node/workspace lifecycle producers outside deployment environment/release/publish-job transitions.
- New deployment controls or destructive lifecycle semantics.
