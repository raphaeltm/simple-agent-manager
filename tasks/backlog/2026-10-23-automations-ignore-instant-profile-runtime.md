# Automations ignore an Instant profile and always start a VM

## Problem

An automation (trigger) whose agent profile has `runtime: 'cf-container'` (Instant) still runs its
task on a Hetzner VM. The automation editor offers Instant profiles without any warning, so a user
who picks one to avoid VM cost gets a VM anyway.

`reserved-task-submission-intent.ts` calls `resolveTaskStartPlacement` without a
`runtimeDecision`. `resolveEffectivePlacementRuntime` (`services/placement-resolver.ts`) treats a
missing decision as `executionRuntime: 'vm'` with `reason: 'vm-only'`, so the profile's requested
runtime is recorded but never used. MCP `dispatch_task` gets this right: it calls
`resolveWorkspaceRuntime` and passes the decision in (`routes/mcp/dispatch-tool.ts`). Workflow
steps refuse Instant profiles explicitly ("Workflow steps currently require a VM profile");
triggers neither run them on Instant nor refuse them.

This affects every trigger type: cron, webhook, GitHub, incident and email.

## Context

Found on 2026-10-23 during the agent email staging test in draft PR #2413. An email automation
using the "Claude MCP Test" profile (`runtime = 'cf-container'`) started task
`01M5K6H7AFBTVTNEPTN6JH1W75`, which provisioned Hetzner VM node `01M5K6HTADK43YQCMGA643GWGN`
(`runtime = 'vm'`, server `171951818`). The node went warm after the run and was deleted by hand.
This predates #2413.

## Acceptance Criteria

- [ ] Decide with Raphaël: run trigger tasks on Instant when the profile asks for it, or refuse
      Instant profiles for automations in the editor and the API, as workflows do
- [ ] If Instant: the trigger submission path resolves a runtime decision the same way MCP
      dispatch does, and a trigger task with an Instant profile starts an Instant session
- [ ] If refused: the editor does not offer Instant profiles for automations, and the create and
      update routes reject them with a clear message
- [ ] A test through the real trigger submission path proves the chosen behavior for an Instant
      profile, with a VM-profile control
- [ ] The automation docs say which runtime automations use
