import type { TokenUsage } from '@simple-agent-manager/acp-client';
import type { AgentInfo, AgentSession } from '@simple-agent-manager/shared';
import type { RefObject } from 'react';

import type { ChatSessionHandle } from '../../components/ChatSession';
import { ChatSession } from '../../components/ChatSession';

export interface LegacyChatSessionsViewProps {
  workspaceId: string;
  workspaceUrl: string;
  runningChatSessions: AgentSession[];
  preferredAgentsBySession: Record<string, AgentInfo['id']>;
  configuredAgents: AgentInfo[];
  activeChatSessionId: string | null;
  onActivity: () => void;
  onUsageChange: (sessionId: string, usage: TokenUsage) => void;
  chatSessionRefs: RefObject<Map<string, ChatSessionHandle>>;
}

/**
 * Fallback chat view for workspaces without a linked project chat session
 * (`workspace.chatSessionId` unset). Renders one ChatSession per running
 * agent session, each owning its own ACP connection. Superseded by
 * WorkspaceChatView for workspaces linked to a project chat session.
 */
export function LegacyChatSessionsView({
  workspaceId,
  workspaceUrl,
  runningChatSessions,
  preferredAgentsBySession,
  configuredAgents,
  activeChatSessionId,
  onActivity,
  onUsageChange,
  chatSessionRefs,
}: LegacyChatSessionsViewProps) {
  return (
    <>
      {runningChatSessions.map((session: AgentSession) => (
        <ChatSession
          key={session.id}
          ref={(h) => {
            if (h) chatSessionRefs.current.set(session.id, h);
            else chatSessionRefs.current.delete(session.id);
          }}
          workspaceId={workspaceId}
          workspaceUrl={workspaceUrl}
          sessionId={session.id}
          worktreePath={session.worktreePath}
          preferredAgentId={
            session.agentType || preferredAgentsBySession[session.id] || configuredAgents.at(0)?.id
          }
          configuredAgents={configuredAgents}
          active={activeChatSessionId === session.id}
          onActivity={onActivity}
          onUsageChange={onUsageChange}
        />
      ))}
    </>
  );
}
