import {
  Activity,
  ExternalLink,
  Eye,
  Lightbulb,
  MessageSquare,
  Monitor,
  Settings,
} from 'lucide-react';
import { useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { extractProjectId } from '../components/NavSidebar';
import type { ChatSessionResponse } from '../lib/api';

// ── Configurable limits ──

const DEFAULT_MAX_CONTEXT_RESULTS = 10;

const MAX_CONTEXT_RESULTS = parseInt(
  import.meta.env.VITE_CMD_PALETTE_MAX_CONTEXT_RESULTS ||
    String(DEFAULT_MAX_CONTEXT_RESULTS),
);

// ── Types ──

export interface CommandPaletteContext {
  projectId: string | undefined;
  sessionId: string | undefined;
  taskId: string | undefined;
}

export interface ContextAction {
  id: string;
  label: string;
  icon: React.ReactNode;
  action: () => void;
}

// ── URL Context Extraction ──

function extractSessionId(pathname: string): string | undefined {
  const match = pathname.match(/^\/projects\/[^/]+\/chat\/([^/]+)/);
  return match?.[1];
}

function extractTaskId(pathname: string): string | undefined {
  // Match both /ideas/:taskId and /tasks/:taskId
  const match = pathname.match(/^\/projects\/[^/]+\/(?:ideas|tasks)\/([^/]+)/);
  return match?.[1];
}

// ── Hook ──

interface UseCommandPaletteContextOptions {
  chatSessions: Array<ChatSessionResponse & { projectId: string; projectName: string }>;
  projects: Array<{ id: string; name: string }>;
}

/**
 * Extracts URL context and builds context-aware actions for the command palette.
 *
 * Actions do NOT call onClose() — the palette's executeResult() handles closing.
 *
 * Returns:
 * - `context`: current projectId/sessionId/taskId from URL
 * - `contextActions`: actions relevant to the current URL context
 */
export function useCommandPaletteContext({
  chatSessions,
  projects,
}: UseCommandPaletteContextOptions) {
  const location = useLocation();
  const navigate = useNavigate();

  const context: CommandPaletteContext = useMemo(() => ({
    projectId: extractProjectId(location.pathname),
    sessionId: extractSessionId(location.pathname),
    taskId: extractTaskId(location.pathname),
  }), [location.pathname]);

  const contextActions: ContextAction[] = useMemo(() => {
    const actions: ContextAction[] = [];
    const { projectId, sessionId, taskId } = context;

    if (!projectId) return actions;

    const projectName = projects.find((p) => p.id === projectId)?.name;
    const prefix = projectName ? `${projectName}: ` : '';

    // ── Project-scoped navigation ──
    actions.push(
      {
        id: 'ctx-project-chat',
        label: `${prefix}Go to Chat`,
        icon: <MessageSquare size={14} />,
        action: () => navigate(`/projects/${projectId}/chat`),
      },
      {
        id: 'ctx-project-ideas',
        label: `${prefix}Go to Ideas`,
        icon: <Lightbulb size={14} />,
        action: () => navigate(`/projects/${projectId}/ideas`),
      },
      {
        id: 'ctx-project-activity',
        label: `${prefix}Go to Activity`,
        icon: <Activity size={14} />,
        action: () => navigate(`/projects/${projectId}/activity`),
      },
      {
        id: 'ctx-project-settings',
        label: `${prefix}Go to Settings`,
        icon: <Settings size={14} />,
        action: () => navigate(`/projects/${projectId}/settings`),
      },
    );

    // ── Session-scoped actions ──
    if (sessionId) {
      const session = chatSessions.find(
        (s) => s.id === sessionId && s.projectId === projectId,
      );

      if (session?.workspaceUrl) {
        actions.push({
          id: 'ctx-go-to-workspace',
          label: 'Go to Workspace',
          icon: <Monitor size={14} />,
          action: () => window.open(session.workspaceUrl!, '_blank'),
        });
      }

      if (session?.taskId) {
        actions.push({
          id: 'ctx-view-task',
          label: 'View Task',
          icon: <Eye size={14} />,
          action: () => navigate(`/projects/${projectId}/ideas/${session.taskId}`),
        });
      }

      if (session?.task?.outputPrUrl) {
        actions.push({
          id: 'ctx-open-pr',
          label: 'Open PR',
          icon: <ExternalLink size={14} />,
          action: () => window.open(session.task!.outputPrUrl!, '_blank'),
        });
      }
    }

    // ── Task/Idea-scoped actions ──
    if (taskId && !sessionId) {
      // Find a session linked to this task
      const linkedSession = chatSessions.find(
        (s) => s.taskId === taskId && s.projectId === projectId,
      );

      if (linkedSession) {
        actions.push({
          id: 'ctx-go-to-chat',
          label: 'Go to Linked Chat',
          icon: <MessageSquare size={14} />,
          action: () => navigate(`/projects/${projectId}/chat/${linkedSession.id}`),
        });

        if (linkedSession.workspaceUrl) {
          actions.push({
            id: 'ctx-task-workspace',
            label: "Go to Task's Workspace",
            icon: <Monitor size={14} />,
            action: () => window.open(linkedSession.workspaceUrl!, '_blank'),
          });
        }
      }

      // Find task's PR URL from a session with this taskId in the same project
      const sessionWithPr = chatSessions.find(
        (s) => s.taskId === taskId && s.projectId === projectId && s.task?.outputPrUrl,
      );
      if (sessionWithPr?.task?.outputPrUrl) {
        actions.push({
          id: 'ctx-task-pr',
          label: 'Open PR',
          icon: <ExternalLink size={14} />,
          action: () => window.open(sessionWithPr.task!.outputPrUrl!, '_blank'),
        });
      }
    }

    return actions.slice(0, MAX_CONTEXT_RESULTS);
  }, [context, projects, chatSessions, navigate]);

  return { context, contextActions };
}
