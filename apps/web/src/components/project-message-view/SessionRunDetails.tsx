/**
 * Session details: the agent, task mode and profile a chat runs with, and which
 * account the agent ran on (and which tier chose it). The account line loads
 * when the details panel opens; only the person who ran the session sees the
 * account's name.
 */
import type { SessionAgentCredential } from '@simple-agent-manager/shared';
import { useQuery } from '@tanstack/react-query';
import { Bot, Cpu, KeyRound, MessageSquare, User2 } from 'lucide-react';

import { useQueryScope } from '../../hooks/useQueryScope';
import { sessionAgentCredentialQueryOptions } from '../../lib/query-options';
import { formatAgentType, formatTaskMode } from './SessionHeaderFormatters';

export interface SessionRunDetailsProps {
  projectId: string;
  sessionId: string;
  agentType: string | null | undefined;
  taskMode: string | null | undefined;
  agentProfileHint: string | null | undefined;
}

export function SessionRunDetails({
  projectId,
  sessionId,
  agentType,
  taskMode,
  agentProfileHint,
}: Readonly<SessionRunDetailsProps>) {
  const queryScope = useQueryScope();
  const credential = useQuery({
    ...sessionAgentCredentialQueryOptions(queryScope, projectId, sessionId),
    enabled: Boolean(queryScope),
  }).data?.credential;

  if (!agentType && !taskMode && !agentProfileHint && !credential) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted min-w-0">
      {agentType && (
        <span className="inline-flex items-center gap-1">
          <Bot size={11} className="opacity-60" aria-hidden="true" />
          <span className="font-medium text-fg-primary">{formatAgentType(agentType)}</span>
        </span>
      )}
      {taskMode && (
        <span className="inline-flex items-center gap-1">
          {taskMode === 'conversation' ? (
            <MessageSquare size={11} className="opacity-60" aria-hidden="true" />
          ) : (
            <Cpu size={11} className="opacity-60" aria-hidden="true" />
          )}
          {formatTaskMode(taskMode)}
        </span>
      )}
      {agentProfileHint && (
        <span className="inline-flex items-center gap-1 min-w-0 max-w-full">
          <User2 size={11} className="opacity-60 shrink-0" aria-hidden="true" />
          <span className="truncate">{agentProfileHint}</span>
        </span>
      )}
      {credential && (
        <span
          className="inline-flex items-center gap-1 min-w-0 max-w-full"
          data-testid="session-agent-credential"
        >
          <KeyRound size={11} className="opacity-60 shrink-0" aria-hidden="true" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{describeCredential(credential)}</span>
        </span>
      )}
    </div>
  );
}

export function describeCredential(credential: SessionAgentCredential): string {
  if (credential.credentialSource === 'platform' || credential.credentialScope === 'platform') {
    return 'SAM platform account';
  }
  const account = credential.isOwnSession
    ? (credential.accountName ?? 'Your account')
    : 'Their own account';
  switch (credential.credentialScope) {
    case 'profile':
      return `${account} · chosen for this profile`;
    case 'project':
      return `${account} · pinned to this project`;
    case 'user':
      return `${account} · ${credential.isOwnSession ? 'your' : 'their'} default`;
    default:
      return account;
  }
}
