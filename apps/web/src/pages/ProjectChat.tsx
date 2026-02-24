import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Spinner } from '@simple-agent-manager/ui';
import { SessionSidebar } from '../components/chat/SessionSidebar';
import { ProjectMessageView } from '../components/chat/ProjectMessageView';
import { TaskSubmitForm } from '../components/task/TaskSubmitForm';
import { TaskExecutionProgress } from '../components/task/TaskExecutionProgress';
import type { TaskSubmitOptions } from '../components/task/TaskSubmitForm';
import type { TaskStatus } from '@simple-agent-manager/shared';
import {
  createProjectTask,
  listChatSessions,
  listCredentials,
  runProjectTask,
  updateProjectTaskStatus,
} from '../lib/api';
import type { ChatSessionResponse } from '../lib/api';
import { useProjectContext } from './ProjectContext';

/** How often to re-poll sessions when a task is actively executing (ms). */
const ACTIVE_SESSION_POLL_MS = 3000;

export function ProjectChat() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();
  const { projectId } = useProjectContext();

  const [sessions, setSessions] = useState<ChatSessionResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasCloudCredentials, setHasCloudCredentials] = useState(false);

  // Active task execution tracking
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [showProgress, setShowProgress] = useState(false);
  const sessionPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Check for Hetzner credentials
  useEffect(() => {
    void listCredentials()
      .then((creds) => setHasCloudCredentials(creds.some((c) => c.provider === 'hetzner')))
      .catch(() => setHasCloudCredentials(false));
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const result = await listChatSessions(projectId, { limit: 100 });
      setSessions(result.sessions);
      return result.sessions;
    } catch {
      // Best-effort — chat sessions may not exist for pre-migration projects
      return [];
    }
  }, [projectId]);

  // Initial load
  useEffect(() => {
    setLoading(true);
    void loadSessions().finally(() => setLoading(false));
  }, [loadSessions]);

  const [submitError, setSubmitError] = useState<string | null>(null);

  const handleRunNow = async (title: string, options: TaskSubmitOptions) => {
    setSubmitError(null);
    try {
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

      // Show the progress tracker
      setActiveTaskId(task.id);
      setShowProgress(true);

      // Start polling sessions more aggressively to pick up the new session
      if (sessionPollRef.current) clearInterval(sessionPollRef.current);
      sessionPollRef.current = setInterval(() => void loadSessions(), ACTIVE_SESSION_POLL_MS);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to start task');
    }
  };

  const handleSaveToBacklog = async (title: string, options: TaskSubmitOptions) => {
    await createProjectTask(projectId, {
      title,
      description: options.description,
      priority: options.priority,
      agentProfileHint: options.agentProfileHint,
    });
  };

  // When the task reaches in_progress and a workspace exists, find the new session
  const handleSessionReady = useCallback(async (_taskId: string, _workspaceId: string) => {
    const freshSessions = await loadSessions();
    // Navigate to the most recent session (should be the new task session)
    if (freshSessions.length > 0) {
      const newest = freshSessions[0];
      if (newest) {
        navigate(`/projects/${projectId}/chat/${newest.id}`, { replace: true });
      }
    }
  }, [loadSessions, navigate, projectId]);

  // When task reaches terminal state, stop aggressive polling
  const handleTerminal = useCallback((_taskId: string, _status: TaskStatus, _errorMessage: string | null) => {
    if (sessionPollRef.current) {
      clearInterval(sessionPollRef.current);
      sessionPollRef.current = null;
    }
    // Reload sessions one final time
    void loadSessions();
  }, [loadSessions]);

  const handleDismissProgress = useCallback(() => {
    setShowProgress(false);
    setActiveTaskId(null);
  }, []);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (sessionPollRef.current) clearInterval(sessionPollRef.current);
    };
  }, []);

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

  // Empty state: show the submit form prominently
  if (sessions.length === 0 && !activeTaskId) {
    return (
      <div style={{
        border: '1px solid var(--sam-color-border-default)',
        borderRadius: 'var(--sam-radius-md)',
        backgroundColor: 'var(--sam-color-bg-surface)',
        overflow: 'hidden',
        minHeight: '400px',
        display: 'flex',
        flexDirection: 'column',
      }}>
        {showProgress && activeTaskId && (
          <TaskExecutionProgress
            projectId={projectId}
            taskId={activeTaskId}
            onSessionReady={handleSessionReady}
            onTerminal={handleTerminal}
            onDismiss={handleDismissProgress}
          />
        )}
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 'var(--sam-space-8)',
          gap: 'var(--sam-space-3)',
        }}>
          <span style={{
            fontSize: 'var(--sam-type-body-size)',
            fontWeight: 600,
            color: 'var(--sam-color-fg-primary)',
          }}>
            Start a task
          </span>
          <span className="sam-type-secondary" style={{
            color: 'var(--sam-color-fg-muted)',
            textAlign: 'center',
            maxWidth: '400px',
          }}>
            Describe what you want the agent to do. It will provision infrastructure,
            clone the repo, and start working autonomously.
          </span>
        </div>
        {submitError && (
          <div style={{
            padding: 'var(--sam-space-2) var(--sam-space-4)',
            color: 'var(--sam-color-danger)',
            fontSize: 'var(--sam-type-caption-size)',
          }}>
            {submitError}
          </div>
        )}
        <TaskSubmitForm
          projectId={projectId}
          hasCloudCredentials={hasCloudCredentials}
          onRunNow={handleRunNow}
          onSaveToBacklog={handleSaveToBacklog}
        />
      </div>
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
        {/* Task execution progress banner */}
        {showProgress && activeTaskId && (
          <TaskExecutionProgress
            projectId={projectId}
            taskId={activeTaskId}
            onSessionReady={handleSessionReady}
            onTerminal={handleTerminal}
            onDismiss={handleDismissProgress}
          />
        )}
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
        {submitError && (
          <div style={{
            padding: 'var(--sam-space-2) var(--sam-space-4)',
            color: 'var(--sam-color-danger)',
            fontSize: 'var(--sam-type-caption-size)',
          }}>
            {submitError}
          </div>
        )}
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
