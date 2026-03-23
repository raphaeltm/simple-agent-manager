import type { FC, MutableRefObject } from 'react';
import { ChatSession } from '../ChatSession';
import type { ChatSessionHandle } from '../ChatSession';
import type { AgentInfo, AgentSession } from '@simple-agent-manager/shared';
import type { TokenUsage } from '@simple-agent-manager/acp-client';

type ViewMode = 'terminal' | 'conversation';

interface WorkspaceAgentPanelProps {
  workspaceId: string;
  workspaceUrl: string;
  sessions: AgentSession[];
  viewMode: ViewMode;
  activeChatSessionId: string | null;
  configuredAgents: AgentInfo[];
  preferredAgentsBySession: Record<string, AgentInfo['id']>;
  chatSessionRefs: MutableRefObject<Map<string, ChatSessionHandle>>;
  onActivity: () => void;
  onUsageChange: (sessionId: string, usage: TokenUsage) => void;
}

export const WorkspaceAgentPanel: FC<WorkspaceAgentPanelProps> = ({
  workspaceId,
  workspaceUrl,
  sessions,
  viewMode,
  activeChatSessionId,
  configuredAgents,
  preferredAgentsBySession,
  chatSessionRefs,
  onActivity,
  onUsageChange,
}) => (
  <>
    {sessions.map((session) => (
      <ChatSession
        key={session.id}
        ref={(handle) => {
          if (handle) chatSessionRefs.current.set(session.id, handle);
          else chatSessionRefs.current.delete(session.id);
        }}
        workspaceId={workspaceId}
        workspaceUrl={workspaceUrl}
        sessionId={session.id}
        worktreePath={session.worktreePath}
        preferredAgentId={
          session.agentType ||
          preferredAgentsBySession[session.id] ||
          (configuredAgents.length > 0 ? configuredAgents[0]!.id : undefined)
        }
        configuredAgents={configuredAgents}
        active={viewMode === 'conversation' && activeChatSessionId === session.id}
        onActivity={onActivity}
        onUsageChange={onUsageChange}
      />
    ))}
  </>
);
