# Usage windows, connector provenance, and choosing an account per run

SAM task `01M7AFE2P7SD68DWW5QXRM7PEZ`. Designs approved by Raphaël on 2026-11-13 from the
prototypes in Library `/design/run-account-prototypes-2026-11-13/` (prototype route
`/prototype/run-account` on branch `sam/two-ui-issues-one-rm7pez`, removed before merge).

## Problem

1. **Connector chip breaks row alignment.** `ConnectorChip` sits in the right-hand badge cluster of
   `SessionItem` with `max-w-[40%]` of an auto-sized grid column, so it truncates itself and pushes
   the hierarchy button inward. At 375px a long connector name hid a row's title and clipped its age.
2. **The usage ring cannot say which window it measures.** `profileUsage()` collapses every window
   into one number (`profileHeadroom`), so a weekly-only account and a 5h account look alike.
3. **The nudge compares unlike numbers.** "6% left" (weekly) next to "Use X · 28% left" (5h).
4. **Using another account needs a second profile.** Runs pick their account from the profile pin →
   project → user default → platform. There is no way to choose an account for one run.

## Approved design

- Connector provenance moves to the meta line: "You · Chat via ChatGPT".
- Ring variant D: arc = 5h left; colour = week health on % left (>50 green, 25–50 amber, <25 red);
  a dot at 12 o'clock when the arc is empty; week used up empties the arc; weekly-only accounts draw
  the week. Words beside it: silent while both windows are above 50%, 5h first, 5h words neutral.
- Picker sheet rows show labelled per-window meters ("5h ▬ 28% · Wk ▬ 69%"); "% left" everywhere,
  including the Profiles page strip (today "% used").
- Nudge names the window and account and offers "Run on <account>" (roomiest compatible account)
  with meters; after use, a line "This chat runs on X instead of Y" with undo.
- Composer control "on <account> ⌄" beside To, listing only accounts for the run's agent. The nudge
  sets the same state. The ring follows the chosen account.
- API: chat start and task submit accept `agentConfigurationId`; validated as the caller's own,
  active, for the run's agent; recorded on the task so the agent-key callback, provider-limit
  admission, the AI proxy and credential write-back all resolve the same account.

## Research findings

- Credential resolution: `packages/shared/src/composable-credentials/resolver.ts`
  (`explainResolution`, tiers profile → project → user → platform; profile/project pins halt when
  unusable, Rule 28). Called through `apps/api/src/services/composable-credentials/resolve.ts`
  (`explainForConsumer`) with a `ProfileCredentialContext`
  (`services/composable-credentials/profile-context.ts`).
- Every runtime resolution builds that context the same way: agent-key callback
  (`routes/workspaces/runtime.ts`), provider-limit admission
  (`durable-objects/task-runner/provider-limit-admission.ts`), the AI proxy
  (`routes/ai-proxy-passthrough-upstream.ts`), and write-back fallback
  (`services/run-agent-credential.ts:selectedRunCredentialReference`). Adding the run account to the
  context makes all four agree. Write-back primarily uses the recorded
  `agent_sessions.agent_credential_reference`, which agent-key records from what it resolved.
- `buildSnapshot` loads only `cc_configurations` owned by the user, so a foreign configuration id
  cannot materialize (fails closed).
- Task writers that must carry the column: `services/submit-task-implementation.ts` (VM),
  `services/submit-instant-task.ts` (Instant), `routes/chat-start.ts` (Instant chat start),
  `services/session-recovery-task.ts` (wake successor), `routes/tasks/run.ts` (re-run).
  Out of scope (agent-created, no per-run account UI): MCP `dispatch_task`, /sam `dispatch_task`,
  /sam `retry_subtask`, reserved SAM submissions, triggers/workflows.
- Web: composer submits through `submitTask` (`pages/project-chat/submitRequest.ts`); per-chat
  overrides live in `useComposerOverrides.ts`; accounts come from `useAccountsData`
  (`AccountView` = one configuration with `usage`). Ring: `ProfileUsageAvatar.tsx`; usage model:
  `profile-picker/usage.ts`; nudge: `ProfileUsageNudge.tsx`; Profiles page strip:
  `agent-profiles/ProfileUsageStrip.tsx`; row: `pages/project-chat/SessionItem.tsx`.
- Window identity: `credentialLimitWindowLabel` / window minutes in
  `packages/shared/src/credential-limits.ts`. Short window = shortest window under a day; week =
  the windows of a week or longer (worst of them).

## Implementation checklist

### Backend
- [ ] D1 migration: `ALTER TABLE tasks ADD COLUMN agent_configuration_id TEXT` + schema.ts column
- [ ] Shared resolver: `run` tier (agent consumers only, above profile), `ResolutionContext.runConfigurationId`, source `run-override`; unusable or other-agent configuration halts
- [ ] Audit every consumer of `ResolutionTier` / `ResolutionSource` / credential scope for the new values
- [ ] `ProfileCredentialContext` carries `runConfigurationId`; the session context reads it from the run's task; `explainForConsumer` passes it
- [ ] `validateRunAgentConfiguration` service: owned, active configuration + credential, consumer agent == run agent; 400 otherwise
- [ ] Accept `agentConfigurationId` in `SubmitTaskSchema` and `StartChatSessionSchema`; persist on insert in submit (VM + Instant) and chat-start
- [ ] Carry it to the wake successor (`session-recovery-task.ts`) and re-run (`routes/tasks/run.ts`)
- [ ] Provider-limit admission reads the task's run account
- [ ] Tests: resolver tiers (run used, run halts on paused/mismatch/foreign, absent → profile), real-SQL vertical slice submit → agent-key resolves the chosen account and records its reference, foreign-configuration attack + owner control, admission uses run account, wake successor keeps it

### Web
- [ ] Connector provenance on the meta line; `ConnectorChip` no longer in `SessionItem`
- [ ] `ProfileUsage` carries per-window readings (short, week) and the ring draws variant D
- [ ] Words: 5h first, silent while both > 50%
- [ ] Picker rows show labelled per-window meters; Profiles strip shows % left
- [ ] Account control beside To; compatible accounts only; state in `useComposerOverrides`; sent as `agentConfigurationId`; ring follows the choice
- [ ] Nudge: names the window, offers "Run on <account>" + meters, then an undo line
- [ ] Remove the prototype route and directory
- [ ] Unit/behavioural tests + Playwright audit (375 / 1280) with long names and every usage state

### Docs
- [ ] Update public docs on agent accounts / profiles for per-run account choice

## Acceptance criteria

- [ ] Connector chats show "Chat via ChatGPT" on the meta line; right-side buttons align on every row
- [ ] The ring's arc is the 5h window and its colour the week; empty shows a dot; weekly-only draws the week
- [ ] Picking "on Work Max" for a run makes that run's agent start on Work Max (agent-key resolves it), admission checks Work Max's limits, and token write-back targets Work Max
- [ ] Another user's configuration id, a paused account, or an account for a different agent is rejected at submit and never resolves
- [ ] A woken session keeps its run account
- [ ] Mobile and desktop screenshots reviewed with no overflow
