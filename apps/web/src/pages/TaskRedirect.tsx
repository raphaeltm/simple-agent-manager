import { Spinner } from '@simple-agent-manager/ui';
import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router';

import { getTaskSessions } from '../lib/api';
import { projectChatPath, projectPath } from '../lib/project-routes';
import { useProjectContext } from './ProjectContext';

/**
 * Redirects legacy `/projects/:projectId/tasks/:taskId` URLs to the task's
 * chat session at `/projects/:projectId/chat/:sessionId`.
 *
 * The standalone task detail page has been removed — tasks are now only
 * accessible through their session in the project chat.
 */
export function TaskRedirect() {
  const { taskId } = useParams<{ taskId: string }>();
  const { projectId } = useProjectContext();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    if (!taskId) {
      setResolved(true);
      return;
    }

    getTaskSessions(projectId, taskId)
      .then((res) => {
        const firstSession = res.sessions[0];
        if (firstSession) {
          setSessionId(firstSession.sessionId);
        }
      })
      .catch(() => {
        // If we can't find the session, fall back to the chat index
      })
      .finally(() => setResolved(true));
  }, [projectId, taskId]);

  if (!resolved) {
    return (
      <div className="flex items-center justify-center p-8">
        <Spinner size="md" />
      </div>
    );
  }

  // A task with a chat opens that chat; one without (never started) opens its project's
  // Overview, where its failure or Running now row is (inbox slice F2).
  const target = sessionId ? projectChatPath(projectId, sessionId) : projectPath(projectId);

  return <Navigate to={target} replace />;
}
