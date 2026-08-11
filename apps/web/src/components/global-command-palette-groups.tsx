import { MessageSquarePlus } from 'lucide-react';
import type { NavigateFunction } from 'react-router';

import type { ContextAction } from '../hooks/useCommandPaletteContext';
import type { SessionSummaryItem } from '../lib/api';
import { fuzzyMatch } from '../lib/fuzzy-match';
import type {
  ActionItem,
  ActionResult,
  CategoryGroup,
  ChatResult,
  NavigationResult,
  NavItem,
  NodeResult,
  ProjectResult,
} from './global-command-palette-types';

interface BuildResultGroupsParams {
  query: string;
  navigationItems: NavItem[];
  projects: Array<{ id: string; name: string }>;
  nodes: Array<{ id: string; name: string }>;
  chatSessions: Array<SessionSummaryItem & { createdAt: number }>;
  actionItems: ActionItem[];
  contextActions: ContextAction[];
  currentProjectId: string | undefined;
  navigate: NavigateFunction;
  maxResultsPerCategory: number;
}

/** Builds fuzzy-matched, scored, and capped result groups for the command palette. */
export function buildResultGroups({
  query,
  navigationItems,
  projects,
  nodes,
  chatSessions,
  actionItems,
  contextActions,
  currentProjectId,
  navigate,
  maxResultsPerCategory,
}: BuildResultGroupsParams): CategoryGroup[] {
  const result: CategoryGroup[] = [];

  // Context — URL-aware actions shown first
  if (contextActions.length > 0) {
    const ctxResults: ActionResult[] = [];
    for (const ctxAction of contextActions) {
      if (!query) {
        ctxResults.push({
          kind: 'action',
          id: ctxAction.id,
          label: ctxAction.label,
          action: ctxAction.action,
          icon: ctxAction.icon,
          score: 0,
          matches: [],
        });
      } else {
        const m = fuzzyMatch(query, ctxAction.label);
        if (m) {
          ctxResults.push({
            kind: 'action',
            id: ctxAction.id,
            label: ctxAction.label,
            action: ctxAction.action,
            icon: ctxAction.icon,
            score: m.score,
            matches: m.matches,
          });
        }
      }
    }
    ctxResults.sort((a, b) => b.score - a.score);
    if (ctxResults.length > 0) {
      result.push({ category: 'Context', results: ctxResults });
    }
  }

  // Navigation
  const navResults: NavigationResult[] = [];
  for (const item of navigationItems) {
    if (!query) {
      navResults.push({ kind: 'navigation', ...item, score: 0, matches: [] });
    } else {
      const m = fuzzyMatch(query, item.label);
      if (m) {
        navResults.push({ kind: 'navigation', ...item, score: m.score, matches: m.matches });
      }
    }
  }
  navResults.sort((a, b) => b.score - a.score);
  if (navResults.length > 0) {
    result.push({ category: 'Navigation', results: navResults });
  }

  // Projects (only if we have data)
  if (projects.length > 0) {
    const projectResults: ProjectResult[] = [];
    for (const project of projects) {
      if (!query) {
        projectResults.push({
          kind: 'project',
          id: project.id,
          label: project.name,
          path: `/projects/${project.id}`,
          score: 0,
          matches: [],
        });
      } else {
        const m = fuzzyMatch(query, project.name);
        if (m) {
          projectResults.push({
            kind: 'project',
            id: project.id,
            label: project.name,
            path: `/projects/${project.id}`,
            score: m.score,
            matches: m.matches,
          });
        }
      }
    }
    projectResults.sort((a, b) => b.score - a.score);
    const capped = projectResults.slice(0, maxResultsPerCategory);
    if (capped.length > 0) {
      result.push({ category: 'Projects', results: capped });
    }
  }

  // Chats (only if we have sessions)
  if (chatSessions.length > 0) {
    const chatResults: ChatResult[] = [];
    for (const session of chatSessions) {
      const displayLabel = session.topic || 'Untitled Chat';
      if (!query) {
        chatResults.push({
          kind: 'chat',
          id: session.id,
          label: displayLabel,
          path: `/projects/${session.projectId}/chat/${session.id}`,
          projectName: session.projectName,
          createdAt: session.createdAt,
          score: 0,
          matches: [],
        });
      } else {
        const m = fuzzyMatch(query, displayLabel);
        if (m) {
          chatResults.push({
            kind: 'chat',
            id: session.id,
            label: displayLabel,
            path: `/projects/${session.projectId}/chat/${session.id}`,
            projectName: session.projectName,
            createdAt: session.createdAt,
            score: m.score,
            matches: m.matches,
          });
        }
      }
    }
    // Sort: when inside a project, prioritize that project's chats.
    // Within same-project group, sort by score then recency.
    chatResults.sort((a, b) => {
      if (currentProjectId) {
        const aIsCurrentProject =
          chatSessions.find((s) => s.id === a.id)?.projectId === currentProjectId;
        const bIsCurrentProject =
          chatSessions.find((s) => s.id === b.id)?.projectId === currentProjectId;
        if (aIsCurrentProject && !bIsCurrentProject) return -1;
        if (!aIsCurrentProject && bIsCurrentProject) return 1;
      }
      return b.score - a.score || b.createdAt - a.createdAt;
    });
    const cappedChats = chatResults.slice(0, maxResultsPerCategory);
    if (cappedChats.length > 0) {
      result.push({ category: 'Chats', results: cappedChats });
    }
  }

  // Quick Actions — per-project actions (only when searching)
  if (projects.length > 0 && query) {
    const quickActionResults: ActionResult[] = [];
    for (const project of projects) {
      const searchText = `${project.name} New Chat`;
      const m = fuzzyMatch(query, searchText);
      if (m) {
        const projectId = project.id;
        quickActionResults.push({
          kind: 'action',
          id: `quick-new-chat-${projectId}`,
          label: searchText,
          action: () => navigate(`/projects/${projectId}/chat`),
          icon: <MessageSquarePlus size={14} />,
          score: m.score,
          matches: m.matches,
        });
      }
    }
    quickActionResults.sort((a, b) => b.score - a.score);
    const cappedQuickActions = quickActionResults.slice(0, maxResultsPerCategory);
    if (cappedQuickActions.length > 0) {
      result.push({ category: 'Quick Actions', results: cappedQuickActions });
    }
  }

  // Nodes (only if we have data)
  if (nodes.length > 0) {
    const nodeResults: NodeResult[] = [];
    for (const node of nodes) {
      if (!query) {
        nodeResults.push({
          kind: 'node',
          id: node.id,
          label: node.name,
          path: `/nodes/${node.id}`,
          score: 0,
          matches: [],
        });
      } else {
        const m = fuzzyMatch(query, node.name);
        if (m) {
          nodeResults.push({
            kind: 'node',
            id: node.id,
            label: node.name,
            path: `/nodes/${node.id}`,
            score: m.score,
            matches: m.matches,
          });
        }
      }
    }
    nodeResults.sort((a, b) => b.score - a.score);
    const capped = nodeResults.slice(0, maxResultsPerCategory);
    if (capped.length > 0) {
      result.push({ category: 'Nodes', results: capped });
    }
  }

  // Actions
  const actionResults: ActionResult[] = [];
  for (const item of actionItems) {
    if (!query) {
      actionResults.push({ kind: 'action', ...item, score: 0, matches: [] });
    } else {
      const m = fuzzyMatch(query, item.label);
      if (m) {
        actionResults.push({ kind: 'action', ...item, score: m.score, matches: m.matches });
      }
    }
  }
  actionResults.sort((a, b) => b.score - a.score);
  if (actionResults.length > 0) {
    result.push({ category: 'Actions', results: actionResults });
  }

  return result;
}
