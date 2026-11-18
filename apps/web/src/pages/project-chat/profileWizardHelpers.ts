import type {
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
  /** Where it will run ("in an Instant container", "on a Cloud VM"), once that is known. */
  runtimeLabel: string | null;
  onCreate: () => Promise<unknown>;
}

/** The composer's placeholder while it waits for an agent or a profile. */
export function getComposerPlaceholder({
  noAgents,
  needsProfileBeforeSubmit,
  quickStartOffered,
  wizardOpen,
  placeholder,
}: Readonly<{
  noAgents: boolean;
  needsProfileBeforeSubmit: boolean;
  /** The gate above offers the one-click profile, so point at it rather than at a wizard. */
  quickStartOffered: boolean;
  wizardOpen: boolean;
  placeholder: string;
}>) {
  if (noAgents) return 'Add an agent in Settings to start chatting...';
  if (needsProfileBeforeSubmit && quickStartOffered && !wizardOpen) {
    return 'Choose Start chatting above to write your first message...';
  }
  if (needsProfileBeforeSubmit || wizardOpen) return 'Create a profile to start chatting...';
  return placeholder;
}
