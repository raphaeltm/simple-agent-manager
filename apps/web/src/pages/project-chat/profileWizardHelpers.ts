import type { AgentProfile, AgentProfileRuntime, TaskMode, VMSize, WorkspaceProfile } from '@simple-agent-manager/shared';
import { DEFAULT_VM_SIZE } from '@simple-agent-manager/shared';

export function resolveWizardRuntime(workType: TaskMode, runtime: AgentProfileRuntime | null): AgentProfileRuntime {
  if (runtime) return runtime;
  return workType === 'conversation' ? 'cf-container' : 'vm';
}

export function resolveWizardWorkspaceProfile(runtime: AgentProfileRuntime, workType: TaskMode): WorkspaceProfile {
  if (runtime === 'cf-container') return 'lightweight';
  if (workType === 'conversation') return 'lightweight';
  return 'full';
}

export function resolveWizardTaskMode(runtime: AgentProfileRuntime, workType: TaskMode): TaskMode {
  if (runtime === 'cf-container') return 'conversation';
  return workType;
}

export function resolveInitialVmSize(defaultVmSize: unknown): VMSize {
  return (defaultVmSize as VMSize | null) ?? DEFAULT_VM_SIZE;
}

export function selectProfileId(current: string | null, profiles: AgentProfile[]) {
  if (current && profiles.some((profile) => profile.id === current)) return current;
  return profiles[0]?.id ?? null;
}

export const FORK_MESSAGE_TEMPLATE = `Use the SAM MCP tools (get_session_messages, search_messages) to review the previous session for full context about what was done and what needs to happen next.
Use get_session_messages with the parent project ID and parent session ID below before relying on title or phrase search.

`;
