/**
 * Single source of truth for "which tools does this session expose".
 *
 * These conditions previously lived as nine inline JSX conditions spread across
 * `SessionHeader` — seven inside the collapsed details disclosure and two as unlabeled
 * icons in the title row. Deriving them once means the rail, any future surface, and
 * the tests all agree about what a given session offers (rules 24 / 59).
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

import type { ChatSessionResponse } from '../../lib/api';
import type { SessionState } from './types';

/**
 * `hidden` still renders a labelled pull-tab, so the strip is always recoverable.
 * The default is `icons`, never `hidden` — defaulting to hidden would recreate the
 * discoverability problem this rail exists to solve.
 */
export type ToolStripMode = 'icons' | 'labels' | 'hidden';

export const TOOL_STRIP_MODES: readonly ToolStripMode[] = ['icons', 'labels', 'hidden'];

export const DEFAULT_TOOL_STRIP_MODE: ToolStripMode = 'icons';

/** Where the user's chosen mode is remembered between sessions. */
export const TOOL_STRIP_MODE_STORAGE_KEY = 'sam-session-tool-strip-mode';

export function isToolStripMode(value: unknown): value is ToolStripMode {
  return typeof value === 'string' && (TOOL_STRIP_MODES as readonly string[]).includes(value);
}

export function nextToolStripMode(mode: ToolStripMode): ToolStripMode {
  const index = (TOOL_STRIP_MODES.indexOf(mode) + 1) % TOOL_STRIP_MODES.length;
  return TOOL_STRIP_MODES[index] ?? DEFAULT_TOOL_STRIP_MODE;
}

export const TOOL_STRIP_MODE_LABEL: Record<ToolStripMode, string> = {
  icons: 'Icons only',
  labels: 'Icons and labels',
  hidden: 'Hidden',
};

/** Groups render with a hairline divider between them. */
export type SessionToolGroup = 'workspace' | 'session' | 'meta';

export type SessionToolId =
  | 'files'
  | 'git'
  | 'workspace'
  | 'timeline'
  | 'comments'
  | 'retry'
  | 'fork'
  | 'report'
  | 'complete'
  | 'details';

export interface SessionToolAction {
  id: SessionToolId;
  label: string;
  /**
   * Full sentence used for both `title` and `aria-label`. In icon-only mode the glyph
   * is the entire visible affordance, so the accessible name has to carry the meaning.
   */
  hint: string;
  icon: LucideIcon;
  group: SessionToolGroup;
  tone?: 'default' | 'success';
  /** Unresolved comment count — a dot in icon mode, a number in label mode. */
  badge?: number;
  /**
   * Amber-tints the badge, matching the header chip's "N needs you" treatment. Without
   * it the two surfaces disagreed about urgency for the same session.
   */
  badgeNeedsAttention?: boolean;
  /** Set for Workspace, which navigates rather than invoking a handler. */
  href?: string;
  disabled?: boolean;
  /**
   * Present on actions that toggle a disclosure, rendered as `aria-expanded`. The
   * accessible NAME stays stable while this changes — screen readers announce the
   * state from the attribute, so varying both is redundant.
   */
  expanded?: boolean;
}

export interface BuildSessionToolActionsInput {
  session: ChatSessionResponse;
  sessionState: SessionState;
  taskEmbed: ChatSessionResponse['task'] | null;
  /** From `getReportIssueConfig()` — null while the config is still loading. */
  reportEnabled: boolean | null;
  unresolvedCommentCount: number;
  /** Subset of the above whose last activity came from someone else. */
  needsAttentionCommentCount?: number;
  /** Handler availability mirrors the old per-button `{onOpenX && ...}` guards. */
  hasFilesHandler: boolean;
  hasGitHandler: boolean;
  hasTimelineHandler: boolean;
  hasCommentsHandler: boolean;
  hasRetryHandler: boolean;
  hasForkHandler: boolean;
  /** True while a mark-complete request is in flight. */
  completing?: boolean;
  /** Drives `aria-expanded` on the Details action. */
  detailsExpanded?: boolean;
}

/** Comment tool hint — attention outranks a plain unresolved count. */
function buildCommentsHint(needsAttentionCount: number, unresolvedCount: number): string {
  if (needsAttentionCount > 0) {
    return `Open comment threads — ${needsAttentionCount} needs you`;
  }
  if (unresolvedCount > 0) {
    return `Open comment threads — ${unresolvedCount} unresolved`;
  }
  return 'Open comment threads on this session';
}

/** Tools that act on the workspace or the conversation's history. */
function buildWorkspaceGroup(input: BuildSessionToolActionsInput): SessionToolAction[] {
  const {
    session,
    sessionState,
    unresolvedCommentCount,
    needsAttentionCommentCount = 0,
    hasFilesHandler,
    hasGitHandler,
    hasTimelineHandler,
    hasCommentsHandler,
  } = input;

  const actions: SessionToolAction[] = [];

  // Files / Git / Workspace need a live workspace to act on.
  if (session.workspaceId && sessionState === 'active') {
    if (hasFilesHandler) {
      actions.push({
        id: 'files',
        label: 'Files',
        hint: 'Browse workspace files',
        icon: FolderOpen,
        group: 'workspace',
      });
    }
    if (hasGitHandler) {
      actions.push({
        id: 'git',
        label: 'Git',
        hint: 'Review uncommitted changes',
        icon: GitCompare,
        group: 'workspace',
      });
    }
    actions.push({
      id: 'workspace',
      label: 'Workspace',
      hint: 'Open the full workspace view',
      icon: ExternalLink,
      group: 'workspace',
      href: `/workspaces/${session.workspaceId}`,
    });
  }

  if (hasTimelineHandler) {
    actions.push({
      id: 'timeline',
      label: 'Timeline',
      hint: 'Jump through session history',
      icon: Clock,
      group: 'workspace',
    });
  }

  if (hasCommentsHandler) {
    actions.push({
      id: 'comments',
      label: 'Comments',
      hint: buildCommentsHint(needsAttentionCommentCount, unresolvedCommentCount),
      icon: MessageSquareQuote,
      group: 'workspace',
      badge: unresolvedCommentCount > 0 ? unresolvedCommentCount : undefined,
      badgeNeedsAttention: needsAttentionCommentCount > 0,
    });
  }

  return actions;
}

/** Tools that act on the task behind the session. */
function buildSessionGroup(input: BuildSessionToolActionsInput): SessionToolAction[] {
  const { session, taskEmbed, hasRetryHandler, hasForkHandler } = input;
  const actions: SessionToolAction[] = [];

  // Retry / Fork act on the task, so they only exist when there is one.
  //
  // `taskEmbed` is the signal Complete already gates on, and the one the WebSocket delta
  // path keeps current. The pre-refactor header read `session.task?.id ?? session.taskId`
  // here and `taskEmbed` for Complete — two signals answering the same question, which
  // could disagree. Consolidating the conditions is the point of this function, so both
  // now read `taskEmbed`, falling back to the session fields only when the embed has not
  // arrived yet (the detail response populates it, list responses do not).
  const hasTask = !!(taskEmbed?.id ?? session.task?.id ?? session.taskId);
  if (hasTask) {
    if (hasRetryHandler) {
      actions.push({
        id: 'retry',
        label: 'Retry',
        hint: 'Retry — re-run this task',
        icon: RotateCcw,
        group: 'session',
      });
    }
    if (hasForkHandler) {
      actions.push({
        id: 'fork',
        label: 'Fork',
        hint: 'Fork — start a new task from this session',
        icon: GitFork,
        group: 'session',
      });
    }
  }

  return actions;
}

/** Cross-cutting tools, pinned to the bottom of the rail. */
function buildMetaGroup(input: BuildSessionToolActionsInput): SessionToolAction[] {
  const { taskEmbed, reportEnabled, completing = false, detailsExpanded = false } = input;
  const actions: SessionToolAction[] = [];

  if (reportEnabled) {
    actions.push({
      id: 'report',
      label: 'Report',
      hint: 'Report an issue with this session',
      icon: Flag,
      group: 'meta',
    });
  }

  const canMarkComplete = !!(
    taskEmbed?.id &&
    taskEmbed.status !== 'completed' &&
    taskEmbed.status !== 'cancelled' &&
    taskEmbed.status !== 'failed'
  );
  if (canMarkComplete) {
    actions.push({
      id: 'complete',
      label: completing ? 'Completing...' : 'Complete',
      hint: 'Mark this task complete',
      icon: CheckCircle2,
      group: 'meta',
      tone: 'success',
      disabled: completing,
    });
  }

  // The old chevron's job, given a name and an icon.
  actions.push({
    id: 'details',
    label: 'Details',
    hint: 'Show session details, IDs and infrastructure',
    icon: Info,
    group: 'meta',
    expanded: detailsExpanded,
  });

  return actions;
}

/**
 * The single source of truth for "which tools does this session expose".
 *
 * Replaces the nine inline JSX conditions the header used to carry (rules 24 / 59), so the
 * rail, the tests, and any future surface all answer that question the same way. Built as
 * three group builders rather than one long function purely for readability — the order of
 * the groups here is the render order, and `isToolGroupStart` draws the dividers from it.
 */
export function buildSessionToolActions(input: BuildSessionToolActionsInput): SessionToolAction[] {
  return [...buildWorkspaceGroup(input), ...buildSessionGroup(input), ...buildMetaGroup(input)];
}

/** True where `actions[index]` starts a new group, so a divider is drawn before it. */
export function isToolGroupStart(actions: SessionToolAction[], index: number): boolean {
  const current = actions[index];
  const previous = actions[index - 1];
  return !!current && !!previous && current.group !== previous.group;
}
