# ProjectData row schema quality hardening

## Problem

A random spot check of `apps/api/src/durable-objects/project-data/` found that the slice does not meet repository quality standards. The highest-risk issue is `row-schemas.ts`: it is 1,139 lines, carries a file-size exception, and mixes unrelated row-parser domains in a single module. The exception claims splitting schemas would create import complexity, but the repository already recommends domain modules plus a thin barrel for exactly this case.

The same slice also has a prohibited source-contract test, `apps/api/tests/unit/durable-objects/project-data-session-validation.test.ts`, which reads implementation files and asserts substrings instead of exercising session validation behavior.

## Research Findings

- `apps/api/src/durable-objects/project-data/row-schemas.ts` is 1,139 lines, above the mandatory 800-line split threshold in `.claude/rules/18-file-size-limits.md`.
- `row-schemas.ts` is not a single coherent schema file. It includes generic aggregates plus ACP sessions, chat sessions/messages, materialization, activity, workspace activity, metadata, cached commands, mailbox, attention, reconciliation, knowledge, policies, and missions.
- `apps/api/src/durable-objects/project-data/index.ts` is 797 lines and remains a broader concern, but splitting the Durable Object facade itself is outside this bounded remediation.
- `apps/api/src/durable-objects/project-data/messages.ts`, `acp-sessions.ts`, and `knowledge.ts` are above 500 lines and should be watched, but they are below the mandatory split threshold or close enough that the smallest useful fix is the central schema module.
- `apps/api/tests/unit/durable-objects/project-data-session-validation.test.ts` is a source-contract test. `.claude/rules/02-quality-gates.md` prohibits `readFileSync` + `toContain()` tests as behavioral proof.
- `apps/api/tests/unit/durable-objects/project-data-broadcast.test.ts` already has a workable `ProjectData` mock harness that can be reused for behavioral WebSocket validation tests.

## Implementation Checklist

- [ ] Split `row-schemas.ts` into domain-focused parser modules under a `row-schemas/` directory while preserving the existing import path through a thin `row-schemas.ts` barrel.
- [ ] Keep each new production source module under the repository file-size ceiling.
- [ ] Remove the unjustified file-size exception from the production source.
- [ ] Preserve all existing named exports from `./row-schemas` so consumers do not need widespread import churn.
- [ ] Replace `project-data-session-validation.test.ts` source-contract assertions with behavioral tests that instantiate `ProjectData` and exercise WebSocket `message.send` validation.
- [ ] Add or preserve behavioral coverage for `persistMessageBatch` rejecting stopped sessions without relying on source text.
- [ ] Run focused API lint/typecheck/tests for the touched Durable Object modules.
- [ ] Run broader repository validation required by `/do` before PR.

## Acceptance Criteria

- `find apps/api/src/durable-objects/project-data -type f -name '*.ts' | xargs wc -l` shows no non-test production file in the touched row-schema split above 800 lines, and no unjustified exception remains.
- Existing consumers of `./row-schemas` continue to compile.
- `project-data-session-validation.test.ts` no longer imports `node:fs` or asserts implementation substrings.
- Behavioral tests prove:
  - WebSocket messages targeting a different session than the socket tag are rejected and not persisted.
  - WebSocket messages targeting missing or non-active sessions are rejected and not persisted.
  - Valid WebSocket user messages are persisted and acknowledged.
  - `persistMessageBatch` rejects stopped sessions.
- Focused API tests for row schemas and ProjectData session validation pass.
- `pnpm --filter @simple-agent-manager/api lint`, `typecheck`, and relevant tests pass.

## References

- `.claude/rules/02-quality-gates.md`
- `.claude/rules/18-file-size-limits.md`
- `apps/api/src/durable-objects/project-data/`
- `apps/api/tests/unit/durable-objects/project-data-broadcast.test.ts`
