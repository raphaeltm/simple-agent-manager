/**
 * The action model shared by both tool-strip variations.
 *
 * Visibility conditions are copied verbatim from the production action row at
 * `components/project-message-view/SessionHeader.tsx:653-715` plus the title-row
 * icon buttons at `:274-311`, so the prototype shows exactly the set of controls a
 * user would really have in each session state. If the prototype graduates, this
 * derivation is what moves into the real header — one source of truth for "which
 * tools does this session expose", instead of nine inline JSX conditions.
 */
import type { LucideIcon } from 'lucide-react';
import {
  CheckCircle2,
  Clock,
  ExternalLink,
  Flag,
  FolderOpen,
  GitCompare,
  GitFork,
  Info,
  MessageSquareQuote,
  RotateCcw,
} from 'lucide-react';

import type { SessionState } from '../../components/project-message-view/types';
import type { ChatSessionResponse } from '../../lib/api';

/** icons → labels → hidden. `hidden` still leaves a tab so the strip is recoverable. */
export type ToolStripMode = 'icons' | 'labels' | 'hidden';

export const TOOL_STRIP_MODES: ToolStripMode[] = ['icons', 'labels', 'hidden'];

export function nextMode(mode: ToolStripMode): ToolStripMode {
  const i = (TOOL_STRIP_MODES.indexOf(mode) + 1) % TOOL_STRIP_MODES.length;
  return TOOL_STRIP_MODES[i] ?? 'icons';
}

export const MODE_LABEL: Record<ToolStripMode, string> = {
  icons: 'Icons only',
  labels: 'Icons and labels',
  hidden: 'Hidden',
};

/** Groups render with a hairline divider between them. */
export type ToolGroup = 'workspace' | 'session' | 'meta';

export interface ToolAction {
  id: string;
  label: string;
  /** Full sentence used for `title` and `aria-label` — the icon alone is not self-describing. */
  hint: string;
  icon: LucideIcon;
  group: ToolGroup;
  tone?: 'default' | 'success';
  /** Unresolved-comment count; renders as a dot in icon mode, a number in label mode. */
  badge?: number;
  /** Set for the Workspace action, which is a plain link in production. */
  href?: string;
}

export function buildToolActions(opts: {
  session: ChatSessionResponse;
  sessionState: SessionState;
  taskEmbed: ChatSessionResponse['task'] | null;
  reportEnabled: boolean;
  unresolvedCommentCount: number;
}): ToolAction[] {
  const { session, sessionState, taskEmbed, reportEnabled, unresolvedCommentCount } = opts;
  const actions: ToolAction[] = [];

  // SessionHeader.tsx:655 — Files/Git/Workspace are gated on a live workspace.
  if (session.workspaceId && sessionState === 'active') {
    actions.push(
      {
        id: 'files',
        label: 'Files',
        hint: 'Browse workspace files',
        icon: FolderOpen,
        group: 'workspace',
      },
      {
        id: 'git',
        label: 'Git',
        hint: 'Review uncommitted changes',
        icon: GitCompare,
        group: 'workspace',
      },
      {
        id: 'workspace',
        label: 'Workspace',
        hint: 'Open the full workspace view',
        icon: ExternalLink,
        group: 'workspace',
        href: `/workspaces/${session.workspaceId}`,
      }
    );
  }

  // SessionHeader.tsx:682,689 — always available.
  actions.push(
    {
      id: 'timeline',
      label: 'Timeline',
      hint: 'Jump through session history',
      icon: Clock,
      group: 'workspace',
    },
    {
      id: 'comments',
      label: 'Comments',
      hint: 'Open comment threads on this session',
      icon: MessageSquareQuote,
      group: 'workspace',
      badge: unresolvedCommentCount > 0 ? unresolvedCommentCount : undefined,
    }
  );

  // SessionHeader.tsx:274-299 — currently unlabeled 14px icons crowding the title row.
  if (session.task?.id ?? session.taskId) {
    actions.push(
      { id: 'retry', label: 'Retry', hint: 'Re-run this task', icon: RotateCcw, group: 'session' },
      {
        id: 'fork',
        label: 'Fork',
        hint: 'Start a new task from this session',
        icon: GitFork,
        group: 'session',
      }
    );
  }

  // SessionHeader.tsx:696 — gated on the report-issue platform config.
  if (reportEnabled) {
    actions.push({
      id: 'report',
      label: 'Report',
      hint: 'Report an issue',
      icon: Flag,
      group: 'meta',
    });
  }

  // SessionHeader.tsx:191-196 — canMarkComplete.
  const canMarkComplete = !!(
    taskEmbed?.id &&
    taskEmbed.status !== 'completed' &&
    taskEmbed.status !== 'cancelled' &&
    taskEmbed.status !== 'failed'
  );
  if (canMarkComplete) {
    actions.push({
      id: 'complete',
      label: 'Complete',
      hint: 'Mark this task complete',
      icon: CheckCircle2,
      group: 'meta',
      tone: 'success',
    });
  }

  // The chevron's job, given a name. Opens the reference IDs / infrastructure block.
  actions.push({
    id: 'details',
    label: 'Details',
    hint: 'Show session details, IDs and infrastructure',
    icon: Info,
    group: 'meta',
  });

  return actions;
}

/** True where `actions[i]` starts a new group, so a divider is drawn before it. */
export function isGroupStart(actions: ToolAction[], index: number): boolean {
  const current = actions[index];
  const previous = actions[index - 1];
  return !!current && !!previous && current.group !== previous.group;
}
