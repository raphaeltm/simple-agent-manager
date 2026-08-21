import type { VMSize } from '@simple-agent-manager/shared';
import { VM_SIZE_LABELS } from '@simple-agent-manager/shared';

import type { ChatSessionResponse } from '../../lib/api';

export function formatVmSize(size: string): string {
  const config = VM_SIZE_LABELS[size as VMSize];
  return config ? config.label : size;
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) {
    const min = Math.floor(ms / 60_000);
    const sec = Math.round((ms % 60_000) / 1000);
    return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  }
  const hrs = Math.floor(ms / 3_600_000);
  const min = Math.round((ms % 3_600_000) / 60_000);
  return min > 0 ? `${hrs}h ${min}m` : `${hrs}h`;
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function formatExecutionStep(step: string | null | undefined): string | null {
  if (!step) return null;
  const labels: Record<string, string> = {
    node_selection: 'Selecting node',
    waiting_for_node_capacity: 'Waiting for node capacity',
    node_provisioning: 'Provisioning node',
    workspace_creation: 'Creating workspace',
    workspace_ready: 'Workspace ready',
    attachment_transfer: 'Transferring files',
    agent_session: 'Agent running',
    running: 'Running',
    awaiting_followup: 'Awaiting follow-up',
  };
  return labels[step] ?? step.replace(/_/g, ' ');
}

export function formatAgentType(agentType: string): string {
  const labels: Record<string, string> = {
    'claude-code': 'Claude Code',
    'openai-codex': 'OpenAI Codex',
  };
  return labels[agentType] ?? agentType;
}

export function getCreatorLabel(session: ChatSessionResponse): string | null {
  if (session.isMine) return 'You';
  if (!session.createdByUserId) return null;
  const creator = session.createdBy;
  return creator?.name?.trim() || creator?.email?.split('@')[0] || 'Member';
}

export function formatTaskMode(mode: string): string {
  return mode === 'conversation' ? 'Conversation' : 'Task';
}
