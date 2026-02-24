import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { EmptyState, Spinner } from '@simple-agent-manager/ui';
import { SessionSidebar } from '../components/chat/SessionSidebar';
import { ProjectMessageView } from '../components/chat/ProjectMessageView';
import { TaskSubmitForm } from '../components/task/TaskSubmitForm';
import type { TaskSubmitOptions } from '../components/task/TaskSubmitForm';
import {
  createProjectTask,
  listChatSessions,
  listCredentials,
  runProjectTask,
  updateProjectTaskStatus,
} from '../lib/api';
import type { ChatSessionResponse } from '../lib/api';
import { useProjectContext } from './ProjectContext';

export function ProjectChat() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();
  const { projectId } = useProjectContext();

  const [sessions, setSessions] = useState<ChatSessionResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasCloudCredentials, setHasCloudCredentials] = useState(false);

  // Check for Hetzner credentials
  useEffect(() => {
    void listCredentials()
      .then((creds) => setHasCloudCredentials(creds.some((c) => c.provider === 'hetzner')))
      .catch(() => setHasCloudCredentials(false));
  }, []);

  const handleRunNow = async (title: string, options: TaskSubmitOptions) => {
    // Create task in draft, transition to ready, then run
    const task = await createProjectTask(projectId, {
      title,
      description: options.description,
      priority: options.priority,
      agentProfileHint: options.agentProfileHint,
    });
    await updateProjectTaskStatus(projectId, task.id, { toStatus: 'ready' });
    await runProjectTask(projectId, task.id, {
      vmSize: options.vmSize,
    });
    // Reload sessions to pick up new task-runner session
    void loadSessions();
  };

  const handleSaveToBacklog = async (title: string, options: TaskSubmitOptions) => {
    await createProjectTask(projectId, {
      title,
      description: options.description,
      priority: options.priority,
      agentProfileHint: options.agentProfileHint,
    });
  };

  const loadSessions = useCallback(async () => {
    try {
      setLoading(true);
      const result = await listChatSessions(projectId, { limit: 100 });
      setSessions(result.sessions);
    } catch {
      // Best-effort — chat sessions may not exist for pre-migration projects
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  // Auto-select the most recent session if none is selected
  useEffect(() => {
    if (!sessionId && sessions.length > 0 && !loading) {
      const mostRecent = sessions[0];
      if (mostRecent) {
        navigate(`/projects/${projectId}/chat/${mostRecent.id}`, { replace: true });
      }
    }
  }, [sessionId, sessions, loading, projectId, navigate]);

  const handleSelect = (id: string) => {
    navigate(`/projects/${projectId}/chat/${id}`);
  };

  if (loading && sessions.length === 0) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sam-space-8)' }}>
        <Spinner size="lg" />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <EmptyState
        heading="No chat sessions"
        description="Chat sessions appear here when tasks run or workspaces connect to this project."
      />
    );
  }

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '280px 1fr',
      border: '1px solid var(--sam-color-border-default)',
      borderRadius: 'var(--sam-radius-md)',
      backgroundColor: 'var(--sam-color-bg-surface)',
      overflow: 'hidden',
      minHeight: '500px',
      maxHeight: 'calc(100vh - 300px)',
    }}>
      {/* Sidebar */}
      <div style={{
        borderRight: '1px solid var(--sam-color-border-default)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: 'var(--sam-space-3) var(--sam-space-3)',
          borderBottom: '1px solid var(--sam-color-border-default)',
          flexShrink: 0,
        }}>
          <span style={{
            fontSize: 'var(--sam-type-secondary-size)',
            fontWeight: 600,
            color: 'var(--sam-color-fg-primary)',
          }}>
            Sessions ({sessions.length})
          </span>
        </div>
        <SessionSidebar
          sessions={sessions}
          selectedSessionId={sessionId ?? null}
          loading={false}
          onSelect={handleSelect}
        />
      </div>

      {/* Main content */}
      <div style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {sessionId ? (
            <ProjectMessageView projectId={projectId} sessionId={sessionId} />
          ) : (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'var(--sam-color-fg-muted)',
              fontSize: 'var(--sam-type-secondary-size)',
            }}>
              Select a session to view messages
            </div>
          )}
        </div>
        <TaskSubmitForm
          projectId={projectId}
          hasCloudCredentials={hasCloudCredentials}
          onRunNow={handleRunNow}
          onSaveToBacklog={handleSaveToBacklog}
        />
      </div>
    </div>
  );
}
