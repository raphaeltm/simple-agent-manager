# Design member offboarding and ownership transfer

## Problem

Wave 6 of shared projects needs a design-first specification for member offboarding and ownership transfer. The shipped waves added shared project membership, invite requests, shared session ownership UX, credential attribution health, and root-pinned subtask credential attribution. The remaining open design area is how owners transfer ownership and how SAM handles live resources that currently run on a departing member's credentials.

This task must produce a specification document PR only. It must not implement runtime code.

## Research Findings

- `/do` context loaded from SAM MCP task `01KWQRVX08GE96PA5XSERPJNQ9`; output branch is `sam/wave-6-design-first-01kwqr`.
- Rule 01 requires behavioral claims in documentation to cite source code paths.
- Rule 26 requires user-facing design to start from project chat where applicable.
- Rule 28 and rule 41 constrain credential-resolution design around explicit fallback behavior, bad-row tolerance, and visible failure instead of silent credential switching.
- Relevant prior task records:
  - `tasks/archive/2026-07-01-project-membership-foundation.md`
  - `tasks/archive/2026-07-04-wave-1b-automation-context-membership-auth.md`
  - `tasks/archive/2026-07-04-wave-1c-deployment-membership-auth.md`
  - `tasks/archive/2026-07-04-credential-attribution-health.md`
  - `tasks/active/2026-07-04-project-compute-credential-attribution.md`
  - trigger and deployment task records under `tasks/archive/2026-04-*` and `tasks/archive/2026-06-*`
- Key code areas to verify and cite:
  - `apps/api/src/routes/projects/members.ts`
  - `apps/api/src/routes/projects/credentials.ts`
  - `apps/api/src/routes/projects/credential-health.ts`
  - `apps/api/src/middleware/project-auth.ts`
  - `apps/api/src/services/provider-credentials.ts`
  - `apps/api/src/services/composable-credentials/resolve.ts`
  - `apps/api/src/services/credential-attribution-health.ts`
  - `apps/api/src/durable-objects/task-runner/workspace-steps.ts`
  - `apps/api/src/routes/triggers/`
  - task, workspace/node, and deployment routes/services that carry credential attribution

## Checklist

- [x] Research current project membership, invite, and authorization code paths.
- [x] Research credential attribution and root-pinned task-tree behavior.
- [x] Research triggers, scheduled tasks, workspaces/nodes, and deployments for credential attribution fields.
- [x] Create a new `specs/<nnn>-project-offboarding/` design spec following existing conventions.
- [x] Define ownership transfer API, authorization, UI surface, old-owner role behavior, and last-owner protection.
- [x] Define member removal/offboarding semantics for every credential-attributed resource type.
- [x] Present re-attach vs break-and-flag as a human-review product decision with a recommendation.
- [x] Cover data model changes, API endpoints, authorization matrix, migration considerations, and implementation wave breakdown.
- [x] Include project-chat-first UI flows per rule 26.
- [x] Cite code paths for every current-behavior claim.
- [x] Run docs-only validation and local review skills before opening PR.

## Validation

- `pnpm install` passed.
- `pnpm typecheck` passed.
- `pnpm lint` passed with existing warnings only.
- `pnpm test` passed on rerun after one unrelated ACP client timing failure; focused ACP client rerun also passed.
- `pnpm build` passed.
- Local reviews completed with `$task-completion-validator`, `$doc-sync-validator`, and `$security-auditor`; no blocking findings for this design-only diff.

## Acceptance Criteria

- A spec document exists under `specs/` and covers the requested design scope.
- The PR contains no runtime implementation code.
- The spec enumerates triggers, task trees, workspaces/nodes, and deployments and defines offboarding behavior for each.
- Last-owner protection and ownership transfer edge cases are explicit.
- The spec contains enough implementation breakdown for follow-up `/do` tasks.
- A PR is opened on `sam/wave-6-design-first-01kwqr`; do not merge unless quality gates pass.
