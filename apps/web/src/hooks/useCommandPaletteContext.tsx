import {
  Activity,
  Bell,
  Brain,
  Clock,
  Eye,
  FolderOpen,
  Lightbulb,
  MessageSquare,
  Monitor,
  Plus,
  Settings,
  UserCog,
  Zap,
} from 'lucide-react';
import { useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { extractProjectId } from '../components/NavSidebar';
import type { SessionSummaryItem } from '../lib/api';

// ── Configurable limits ──

const DEFAULT_MAX_CONTEXT_RESULTS = 20;

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

// ── Static action definitions ──

interface ProjectActionItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  path: string;
}

// Project-scoped navigation targets. `path` is appended to `/projects/:projectId/`.
const PROJECT_NAV_ITEMS: ProjectActionItem[] = [
  { id: 'ctx-project-chat', label: 'Go to Chat', icon: <MessageSquare size={14} />, path: 'chat' },
  { id: 'ctx-project-ideas', label: 'Go to Ideas', icon: <Lightbulb size={14} />, path: 'ideas' },
  { id: 'ctx-project-activity', label: 'Go to Activity', icon: <Activity size={14} />, path: 'activity' },
  { id: 'ctx-project-settings', label: 'Go to Settings', icon: <Settings size={14} />, path: 'settings' },
  { id: 'ctx-project-library', label: 'Go to Library', icon: <FolderOpen size={14} />, path: 'library' },
  { id: 'ctx-project-agent-context', label: 'Go to Agent Context', icon: <Brain size={14} />, path: 'agent-context' },
  { id: 'ctx-project-notifications', label: 'Go to Notifications', icon: <Bell size={14} />, path: 'notifications' },
  { id: 'ctx-project-triggers', label: 'Go to Triggers', icon: <Clock size={14} />, path: 'triggers' },
  { id: 'ctx-project-profiles', label: 'Go to Profiles', icon: <UserCog size={14} />, path: 'profiles' },
  { id: 'ctx-project-skills', label: 'Go to Skills', icon: <Zap size={14} />, path: 'skills' },
];

// Project-scoped create actions. `?edit=new` opens the create editor on the target page.
const PROJECT_CREATE_ITEMS: ProjectActionItem[] = [
  { id: 'ctx-create-trigger', label: 'Create Trigger', icon: <Plus size={14} />, path: 'triggers?edit=new' },
  { id: 'ctx-create-profile', label: 'Create Profile', icon: <Plus size={14} />, path: 'profiles?edit=new' },
  { id: 'ctx-create-skill', label: 'Create Skill', icon: <Plus size={14} />, path: 'skills?edit=new' },
];

// ── Hook ──

interface UseCommandPaletteContextOptions {
  chatSessions: Array<SessionSummaryItem & { createdAt: number }>;
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

    // ── Project-scoped navigation + create actions ──
    for (const item of [...PROJECT_NAV_ITEMS, ...PROJECT_CREATE_ITEMS]) {
      actions.push({
        id: item.id,
        label: `${prefix}${item.label}`,
        icon: item.icon,
        action: () => navigate(`/projects/${projectId}/${item.path}`),
      });
    }

    // ── Session-scoped actions ──
    if (sessionId) {
      const session = chatSessions.find(
        (s) => s.id === sessionId && s.projectId === projectId,
      );

      if (session?.workspaceId) {
        actions.push({
          id: 'ctx-go-to-workspace',
          label: 'Go to Workspace',
          icon: <Monitor size={14} />,
          action: () => navigate(`/workspaces/${session.workspaceId}`),
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

      // Note: outputPrUrl is only available via the detail endpoint (task embed),
      // not the list endpoint. Command palette uses list data, so this is skipped.
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

        if (linkedSession.workspaceId) {
          actions.push({
            id: 'ctx-task-workspace',
            label: "Go to Task's Workspace",
            icon: <Monitor size={14} />,
            action: () => navigate(`/workspaces/${linkedSession.workspaceId}`),
          });
        }
      }

      // Note: PR URL (outputPrUrl) is only available via the detail endpoint
      // (task embed), not the list endpoint used by the command palette.
    }

    return actions.slice(0, MAX_CONTEXT_RESULTS);
  }, [context, projects, chatSessions, navigate]);

  return { context, contextActions };
}
