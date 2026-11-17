import type {
  AgentInfo,
  AgentProfileRuntime,
  TaskMode,
  VMSize,
  WorkspaceProfile,
} from '@simple-agent-manager/shared';
import { DEFAULT_VM_SIZE } from '@simple-agent-manager/shared';

/**
 * The runtime a new profile gets. A chat defaults to Instant only where this installation can
 * run it (`GET /api/config/instant-runtime`); otherwise, and for task work, a Cloud VM.
 */
export function resolveWizardRuntime(
  workType: TaskMode,
  runtime: AgentProfileRuntime | null,
  instantAvailable = true
): AgentProfileRuntime {
  if (runtime) return runtime;
  return workType === 'conversation' && instantAvailable ? 'cf-container' : 'vm';
}

export function resolveWizardWorkspaceProfile(
  runtime: AgentProfileRuntime,
  workType: TaskMode
): WorkspaceProfile {
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

const FORK_MESSAGE_TEMPLATE = `Use the SAM MCP tool sessions_read (methods messages and search) to review the previous session for full context about what was done and what needs to happen next.
Use sessions_read method messages with the parent session ID below before relying on title or phrase search.

`;

/** Composer text for a fork: the IDs the new agent needs to read the previous session. */
export function buildForkMessage({
  sessionLabel,
  projectId,
  sessionId,
  taskId,
}: Readonly<{ sessionLabel: string; projectId: string; sessionId: string; taskId: string }>) {
  const ids = [
    `Previous session: "${sessionLabel}"`,
    `Parent project ID: ${projectId}`,
    `Parent session ID: ${sessionId}`,
    ...(taskId ? [`Parent task ID: ${taskId}`] : []),
  ];
  return `${FORK_MESSAGE_TEMPLATE}${ids.join('\n')}\n\n`;
}

/** The one-click path, offered only when the project has exactly one configured agent. */
export interface NoProfilesQuickStart {
  agentName: string;
  /** Name of the profile the click creates, shown so nothing is created invisibly. */
  profileName: string;
  onCreate: () => Promise<unknown>;
}

/** The quick start for a project with exactly one configured agent, otherwise none. */
export function soleAgentQuickStart(
  agents: AgentInfo[],
  suggestProfileName: (agentType: string | null, workType: TaskMode | null) => string,
  onCreate: (() => Promise<unknown>) | undefined
): NoProfilesQuickStart | undefined {
  const soleAgent = agents.length === 1 ? agents[0] : undefined;
  if (!soleAgent || !onCreate) return undefined;
  return {
    agentName: soleAgent.name,
    profileName: suggestProfileName(soleAgent.id, 'conversation'),
    onCreate,
  };
}

/** The composer's placeholder while it waits for an agent or a profile. */
export function getComposerPlaceholder({
  noAgents,
  needsProfileBeforeSubmit,
  wizardOpen,
  placeholder,
}: Readonly<{
  noAgents: boolean;
  needsProfileBeforeSubmit: boolean;
  wizardOpen: boolean;
  placeholder: string;
}>) {
  if (noAgents) return 'Add an agent in Settings to start chatting...';
  if (needsProfileBeforeSubmit || wizardOpen) return 'Create a profile to start chatting...';
  return placeholder;
}
