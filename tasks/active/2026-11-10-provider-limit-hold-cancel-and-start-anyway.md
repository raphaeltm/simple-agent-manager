# Cancel or force through a task held by a provider usage limit

## Problem

A task held at admission by a provider usage limit ("Waiting for provider limit reset at 06:58 UTC")
gives its owner no way out:

1. **No cancel.** The session tool rail offers only **Complete**, which the API rejects for a task
   that never started: `Invalid transition queued -> completed. Allowed: delegated, failed, cancelled`
   (observed 2026-11-10 on the PR Shepherd cron task). The task then spawns at the reset whether the
   owner still wants it or not.
2. **No force.** SAM's admission hold is a prediction from a stored `credential_limit_windows`
   rejection. That window reflects the subscription only: an account with extra credits/overage can
   still serve the prompt. Raphaël has ~31k credits on the held account and wants to opt in to
   spending them. Today **Resume task** appears only after the hold is `blocked`, and its
   no-snapshot path just clears the wait so `holdTaskForProviderLimit` re-holds on the same window.

## Research findings

- Production evidence (2026-11-10): task `cron-b73da84079…` `status=queued`,
  `execution_step=node_selection`, `admission_state=provider_limit_waiting`, wait
  `phase=waiting origin=admission`, no workspace/snapshot.
- Server cancel already works: `POST /tasks/:id/status {toStatus:'cancelled'}` → `cancelTask()`
  (`apps/api/src/services/cancel-task.ts`). The runner's alarm then calls `assertRecoveryAuthority`,
  which revokes a cancelled task, so nothing provisions. Gap is UI only:
  `buildMetaGroup()` in `apps/web/src/components/project-message-view/session-tool-actions.ts`
  offers `complete` for every non-terminal status, but `draft/ready/queued/delegated` cannot complete
  (`apps/api/src/services/task-status.ts` TRANSITIONS).
- Admission hold: `holdTaskForProviderLimit()` (`apps/api/src/durable-objects/task-runner/provider-limit-admission.ts`)
  runs on every runner alarm at `node_selection` and pre-start `agent_session`.
  Owner resume `resumeProviderLimitTask()` (`apps/api/src/services/provider-limit-recovery.ts`) only
  accepts `phase=blocked`.
- Agent-key pin `assertProviderLimitCredentialPin()` passes a non-blocked wait whose `credentialKey`
  matches the injected credential, so a `released` override wait for the same key is honoured there.
- A genuine provider rejection after the override goes through `provider-limit-parking.ts`, which
  builds a fresh wait via `newProviderLimitWait()` (the override field is not carried), so the task
  parks normally.
- Root cause of the false hold: `packages/vm-agent/internal/acp/session_host_usage_claude.go` keeps
  only `status/utilization/resetsAt` from Claude `rate_limit_info` and drops overage/extra-usage
  fields. Recorded as an idea (not fixed here: needs the exact Claude Code payload verified).
- Callback-origin (mid-run, parked) waits are out of scope; recorded as follow-up in the idea.

## Implementation checklist

- [ ] Shared/API: optional `ownerOverride { credentialKey, grantedAt }` on `ProviderLimitWaitSchema`
- [ ] API: `startProviderLimitTaskAnyway()` service: owner only, admission origin, phase waiting|blocked,
      status queued|delegated, CAS on wait JSON, records released wait + override, clears admission
      state, nudges the runner; restores the hold if the runner is unavailable
- [ ] API: `POST /:taskId/provider-limit/start-anyway` route (task:write capability + owner)
- [ ] API: admission honours an override for the same credential key at node_selection and agent_session;
      a changed credential still blocks
- [ ] API: expose `providerLimitCanStartAnyway` on the chat session task embed
- [ ] Web: rail shows **Cancel task** (→ `cancelled`) instead of **Complete** for draft/ready/queued/delegated,
      with its own confirm copy
- [ ] Web: provider-limit notice offers **Start anyway** (owner, admission hold) with a line explaining it
      may spend extra credits
- [ ] Tests: runner-alarm integration (override proceeds past a live rejected window; credential change
      still blocks; cancelled held task's alarm provisions nothing); route/service guards (non-owner,
      callback origin, wrong status); web rail + notice behaviour
- [ ] Playwright visual audit (mobile + desktop) of the held-session notice and rail
- [ ] Docs: user-facing provider-limit docs mention Cancel task / Start anyway
- [ ] Idea: Claude overage fields ignored (root cause) + callback-origin force follow-up

## Acceptance criteria

- [ ] Owner can cancel a queued task held by a provider limit from the session view; it never provisions
- [ ] Owner can start a held, never-started task immediately; it provisions and starts on the same credential
- [ ] If the selected credential changes after the override, the task blocks for review again
- [ ] Non-owners and callback-origin waits cannot use Start anyway
