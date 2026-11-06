# Per-workspace SAM identity env on shared nodes

## Problem

On a node that hosts more than one workspace, an agent's `SAM_TASK_MODE`, `SAM_TASK_ID`,
`SAM_CHAT_SESSION_ID` and `SAM_PROJECT_ID` describe the session that first booted the
node, not the agent's own session.

Observed 2026-11-06 on production node `01M6R3GTEHQNN9N3X4NXEBQATQ` (booted for a
conversation session, task `01M6R3GAPSBBT6PAEWCCAES28M`): a later workspace on the same
node, for task `01M6R8VEAWPS7E8M8TJQHVMVM7` (`task_mode = 'task'` in D1), had
`SAM_TASK_MODE=conversation`, `SAM_TASK_ID=01M6R3GAPS…` and the first session's
`SAM_CHAT_SESSION_ID`. `SAM_WORKSPACE_ID` and `SAM_BRANCH` were correct. Idea
`01M6R9CWV3R5PTZD274NX7NNQC`.

## Research findings

1. **Node-level fallback.** `server.go` builds `acpConfig.SAMEnvFallback` once from the
   node boot config (`cfg.BuildSAMEnvFallback()`, `config/env_fallback.go`). Every
   SessionHost copies `s.acpConfig` (`agent_ws.go` `getOrCreateSessionHost`), so every
   session on the node gets the boot session's identity for any key missing from the
   container env files (`acp/session_host_startup.go` `resolveAgentEnvVars`).
2. **`SAM_TASK_MODE` always comes from that fallback.** `/etc/sam/env` and
   `/etc/profile.d/sam-env.sh` (`bootstrap.go` `buildSAMStaticEnv` / `buildSAMEnvScript`)
   never contain it.
3. **Stale IDs in the env files.** `workspace_provisioning.go` (provision and recovery)
   copies `*s.config` and overrides workspace ID, repository, branch etc., but not
   `ProjectID`, `TaskID` or `ChatSessionID`, so `/etc/sam/env` and `sam-env.sh` get the
   boot session's IDs.
4. **The per-workspace values already exist on the VM agent.** `WorkspaceRuntime` has
   `ProjectID`, `TaskID` (from the create request) and `ChatSessionID` (from
   agent-session create). The session's task ID and mode arrive on agent-session start
   (`workspaces.go`, stored in `sessionTaskCtx`). The task runner, Instant and container
   recovery all pass them (`agent-session-step.ts`, `instant-session.ts`,
   `vm-agent-container-recovery.ts`). No API change is needed.
5. **Standalone (Instant) has the same bug the other way round.** The cf-container sets
   `WORKSPACE_ID` but not `TASK_MODE` (`vm-agent-container.ts`), so config defaults to
   `task`, and an Instant conversation session gets `SAM_TASK_MODE=task`. The session
   task context must win over the boot config.
6. The existing completion-callback fallback in `agent_ws.go` already falls back to boot
   config only when `workspaceID == s.config.WorkspaceID`. The identity helper reuses
   that rule.
7. **Ordering.** Agent-session start sets `sessionTaskCtx` before calling
   `getOrCreateSessionHost`, the same place the completion callback binds. The env is
   bound there too.
8. `onboarding-tools.ts` lists SAM env vars for agents; it omits `SAM_TASK_MODE` and
   says `SAM_TASK_ID` is task-mode only, which is wrong (every chat is task-backed).

## Implementation checklist

- [x] Add a server helper that returns a workspace's SAM identity (project, chat
      session, task ID, task mode): runtime values first, session task context over
      them, boot config only for the boot workspace.
- [x] Use it in both config copies in `workspace_provisioning.go`, so `/etc/sam/env`
      and `sam-env.sh` never carry another workspace's IDs.
- [x] Build `SAMEnvFallback` per SessionHost from that identity in
      `getOrCreateSessionHost`, instead of inheriting the node-level list.
- [x] Tests: a shared-node SessionHost for a non-boot workspace gets its own task mode,
      task ID, chat session ID and project ID, and none of the boot values (driven
      through agent-session start, not the helper directly).
- [x] Tests: the boot workspace still gets the boot values when no session context
      exists; session context beats boot config (Instant/standalone `task` default).
- [x] Tests: provisioning config for a non-boot workspace carries the runtime's
      project/task IDs and does not inherit the boot chat session ID.
- [x] Prove the tests discriminate: revert each fix and confirm the intended tests fail.
- [x] Update the env var list in `onboarding-tools.ts`.
- [x] Review (test-engineer, MEDIUM): session identity keys from the per-session fallback
      replace stale `/etc/sam/env` values (a workspace reused by a later task keeps the
      first task's IDs); other keys still only fill gaps (`acp/session_host_sam_env.go`
      `mergeSAMEnvFallback`).
- [x] Review (go-specialist, HIGH x2): `mcp_build.go` and `primeRestoredMessageReporter`
      borrowed the boot project for any workspace (the restore path also persisted it);
      both now use `workspaceSAMIdentity`. Attack + owner-control tests added.
- [x] Review (go-specialist, MEDIUM): identity fields read under `workspaceMu.RLock`.

## Acceptance criteria

- [x] A second workspace on a shared node starts its agent with its own
      `SAM_TASK_MODE`, `SAM_TASK_ID`, `SAM_CHAT_SESSION_ID`, `SAM_PROJECT_ID`.
- [x] `/etc/sam/env` for a non-boot workspace never contains the boot workspace's
      task or chat IDs.
- [x] An Instant conversation session reports `SAM_TASK_MODE=conversation`.
- [ ] Verified on staging with two sessions of different modes on one node.

## References

- `.claude/rules/61-guards-must-cover-every-runtime.md` (VM + standalone)
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `packages/vm-agent/.claude/rules/27-vm-agent-staging-refresh.md`

## Notes

Discrimination proof (each fix reverted alone, then restored):

1. Session env built from the node config again (`s.config.BuildSAMEnvFallback()`): all three
   `TestSharedNodeSessionGetsItsOwnSAMIdentity` cases fail, reproducing production
   (`SAM_TASK_MODE = "conversation", want "task"`, `SAM_TASK_ID = "task-boot"`, every boot ID leaked).
2. Identity not applied in `workspaceBootstrapConfig`: both
   `TestProvisioningConfigCarriesTheWorkspaceIdentity` cases fail with the boot identity.
3. Boot task-mode gate removed: only `TestBootWorkspaceSAMIdentity/boot_mode_never_describes_a_task_it_did_not_name` fails.

The task-completion validator repeated reverts 1 and 2 independently with the same result.

Review-fix discrimination:

4. Identity override removed from `mergeSAMEnvFallback`: only
   `TestMergeSAMEnvFallbackSessionIdentityBeatsStaleEnvFile` fails (`SAM_TASK_ID=task-first` kept).
5. Old `mcp_build.go` fallback restored: only `TestMcpBuildAndPublish_OtherWorkspaceDoesNotBorrowBootProject` fails.
6. Old restore-reporter fallback restored: only `TestPrimeRestoredMessageReporter_OtherWorkspaceDoesNotBorrowBootProject`
   fails, showing the reporter bound to `proj-boot` and `proj-boot` persisted onto the other workspace.

Deferred (MEDIUM, test-engineer): after a VM-agent restart, a plain WebSocket reconnect to the
node's boot workspace synthesizes the boot task context in `agent_ws.go` (pre-existing). It only
matters if that workspace was later reassigned to another task, and closing it needs
`WorkspaceRuntime.TaskID` persisted across restarts. Tracked as a SAM Idea.
