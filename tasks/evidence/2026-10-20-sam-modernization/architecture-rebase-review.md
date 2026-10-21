# Architecture review after shared-session rebase

Reviewed on 2026-10-20 at branch head `f632868430ea1648bbb062548495677d2951b51c`, including main commit `6a7c2995c7731573f28ca64da0fe71725efae857` (PR #2383). This review covers local source and tests; it does not claim a live staging or production result.

**Verdict: pass for the reviewed integration.** No production source correction was needed after the rebase.

## Shared-session authority and effect fences

- `apps/api/src/services/send-chat.ts` retains the shared owner/grantee authority check. Resource/profile resolution uses the session owner; prompt attribution uses the human actor and the existing grant ID. The upstream extraction of display-name loading into `shared-session-names.ts` preserves those identities.
- The SAM effect callback runs after asynchronous profile-mention enrichment, before cancelling scheduled sleep, and again **after** the asynchronous shared-name lookup immediately before durable prompt acceptance. The callback rechecks account/installation status, current project/session authority, and the private turn generation/cancellation fence.
- A SAM follow-up requires durable delivery. The upstream owner-only live fallback remains available to existing callers without a SAM effect callback; SAM cannot bypass its fence through that fallback.
- Upstream teammate attachment support remains intact. The SAM `sam_chat_send` input exposes only scoped session identifiers and content; the shared-service change adds no attachment/upload capability to the model.
- Confirmed destructive actions still revalidate the stored operation schema and current authority. The `stopChat` integration retains effect checks before backing-task changes, agent cancellation/stop, and final chat persistence. Resources resolve under the session owner while the actor remains attributable.
- Write-receipt projection rechecks session-writer authority, including grant revocation, before exposing stored inputs/results. The explicit model operation allowlist remains unchanged by the rebase.

## Event and watch authority

- `operator/work.ts` requires current project access and an exact D1 match on task ID, project ID, caller user ID, and chat session ID before subscription creation or event reads. Following up in a teammate's shared session does not create an own-work watch for their task.
- Subscriptions remain human-owned and `record_only`, with exact task/session subjects and target scope. ProjectData applies subscription visibility checks; the private inbox persists only event references/type/timestamps, not event text. These watches do not inject prompts, interrupt project agents, or run the model.
- PR #2383's owner-only standing-watch rules and grant-scoped scheduled-message rules remain intact. Private SAM observation uses the event subscription/pull path; it does not bypass or add model access to those scheduling surfaces.
- Work-card reads recheck membership and exact task ownership. Disable, generation changes, expiry, and exhausted retry budgets stop active observation. The persisted cursor/attempt/deadline and cap of25 candidates retain fairness and the previously reviewed I/O bounds.

## Local verification

All commands completed successfully against the rebased production sources.

| Suite                                                                                                                          | Result                  |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| Shared send-chat, attachments, session-writer authority, SAM security/work, event subscription service and delivery preference | 7 files,65 tests passed |
| Real Worker shared-session schedules, attachments, access vertical slice, project-event member subscriptions                   | 4 files,34 tests passed |
| Native bundled Worker/Mastra suite, run by the ordinary `test:workers` wrapper                                                 | 1 file,19 tests passed  |

The Worker tests exercised expected rejected RPCs and emitted their rejection diagnostics. The test process exited successfully with no failed tests.

Commands:

```bash
pnpm --dir apps/api exec vitest run \
  tests/unit/services/send-chat-shared-session.test.ts \
  tests/unit/services/send-chat-attachments.test.ts \
  tests/unit/services/session-access-writer.test.ts \
  tests/unit/durable-objects/sam-operator-security.test.ts \
  tests/unit/durable-objects/sam-operator-work.test.ts \
  tests/unit/services/project-event-subscriptions.test.ts \
  tests/unit/services/project-event-subscription-delivery-preference.test.ts

pnpm --dir apps/api test:workers \
  tests/workers/shared-session-schedules.test.ts \
  tests/workers/shared-session-attachments.test.ts \
  tests/workers/shared-session-access-vertical-slice.test.ts \
  tests/workers/project-event-member-subscriptions.test.ts
```

Local logs: `/tmp/sam-rebase-authority-tests.log` and `/tmp/sam-rebase-workers-authority.log`.

## Prepared dispatch evaluation refinement

The unrun `staging-sam-dispatch.spec.ts` was strengthened without changing its VM or model-turn budget. It now reconstructs contiguous assistant text transiently so a streamed project report fixture or private-marker leak cannot evade checks by splitting across chunks. The completed chat-read receipt must precede the completed same-session follow-up receipt.

ESLint, standalone strict TypeScript, and Playwright `--list` passed. Discovery found exactly one Desktop test; no browser or live action was run for this review. Read-receipt input is intentionally server-redacted, so receipt ordering establishes the operation order, while the exact read target remains specified by the scoped prompt rather than independently exposed in the receipt. The actual assistant-role report, same-session follow-up, applied runtime-contract scalars, and cleanup are assertions for the later authorized live run.

The subsequent readiness check corrected two test assumptions. Project identity is asserted by exact ID and repository, without a cosmetic name requirement. The hardware gate persists the node's **observed** vCPU count, memory, source and heartbeat; configured size fields alone cannot pass. Missing observed metadata waits within the existing deadline, while known invalid or out-of-envelope values fail immediately. Passing requires positive finite observed values within the preflight catalog cost envelope of 8 vCPU and 16384 MB, a fresh node heartbeat, and the same workspace's fresh ACP heartbeat.

The earlier 2-vCPU/4-GB physical-host assertion was stricter than repository policy and has been corrected. Rule 09 lines 91–94 cap the **workload request**, while allowing the scheduler to pack that request onto a larger pooled host. The test now reads the public workspace response's `resolvedReservationJson`, persists only its CPU/memory scalars, and requires positive integer reservations of at most 2000 millicores and 3584 MB (3.5 GB). The small profile label alone is not evidence of that bound; neither node nor workspace size labels are treated as physical caps. The 8-vCPU/16-GB host envelope is a separate staging cost bound, not a policy exception. One 15-minute lifecycle, one dispatch, same-session follow-up and owned cleanup remain unchanged. No pool configuration, credential, or grant changes are needed.

Response and cleanup contracts were checked against current project/task/chat/ACP/profile/workspace/node routes and the node response mapper. Workspace deletion can return accepted/pending, so the test waits for disappearance; node deletion requires confirmed runtime termination server-side and is also followed by a disappearance check. Cleanup remains restricted to the recorded dispatch's new workspace, a new empty workspace-role node, and its unique temporary profile after work cleanup. Pre-existing nodes are retained. Prettier, ESLint, standalone strict TypeScript and single-test Playwright discovery passed again; the dispatch remains unrun.
