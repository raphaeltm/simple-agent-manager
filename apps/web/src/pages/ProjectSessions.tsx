import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Spinner } from '@simple-agent-manager/ui';
import { ChatSessionList } from '../components/ChatSessionList';
import { listChatSessions } from '../lib/api';
import type { ChatSessionResponse } from '../lib/api';
import { useProjectContext } from './ProjectContext';

export function ProjectSessions() {
  const navigate = useNavigate();
  const { projectId } = useProjectContext();

  const [chatSessions, setChatSessions] = useState<ChatSessionResponse[]>([]);
  const [loading, setLoading] = useState(true);

  const loadChatSessions = useCallback(async () => {
    try {
      setLoading(true);
      const result = await listChatSessions(projectId, { limit: 50 });
      setChatSessions(result.sessions);
    } catch {
      // Best-effort — chat sessions may not exist for pre-migration projects
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void loadChatSessions(); }, [loadChatSessions]);

  if (loading && chatSessions.length === 0) {
    return (
      <div className="flex items-center gap-2 p-4">
        <Spinner size="sm" />
        <span className="sam-type-secondary text-fg-muted">Loading sessions...</span>
      </div>
    );
  }

  return (
    <section className="border border-border-default rounded-md bg-surface overflow-hidden">
      <ChatSessionList
        sessions={chatSessions}
        onSelect={(sessionId) => navigate(`/projects/${projectId}/sessions/${sessionId}`)}
      />
    </section>
  );
}
