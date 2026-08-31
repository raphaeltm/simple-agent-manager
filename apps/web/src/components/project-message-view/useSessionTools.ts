/**
 * Owns everything the session tool rail needs: strip mode (persisted), the report-issue
 * config gate, the mark-complete flow, and the dialogs those actions open.
 *
 * This state used to live inside `SessionHeader` alongside the action row. It moved out
 * with the actions themselves so the header stays presentational and the rail has a
 * single place to dispatch from.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ChatSessionResponse } from '../../lib/api';
import { getReportIssueConfig, updateProjectTaskStatus } from '../../lib/api';
import {
  buildSessionToolActions,
  DEFAULT_TOOL_STRIP_MODE,
  isToolStripMode,
  nextToolStripMode,
  type SessionToolAction,
  type SessionToolId,
  TOOL_STRIP_MODE_STORAGE_KEY,
  type ToolStripMode,
} from './session-tool-actions';
import type { SessionState } from './types';

/** Read the persisted mode. Storage can throw in private-mode Safari, so it fails soft. */
function readStoredMode(): ToolStripMode {
  try {
    const raw = window.localStorage.getItem(TOOL_STRIP_MODE_STORAGE_KEY);
    return isToolStripMode(raw) ? raw : DEFAULT_TOOL_STRIP_MODE;
  } catch {
    return DEFAULT_TOOL_STRIP_MODE;
  }
}

/**
 * Compile-time proof that every `SessionToolId` has a dispatch case.
 *
 * The parameter is typed `never`, so adding an id without a matching `case` fails
 * typecheck at the call site rather than shipping a control that does nothing when
 * clicked. At runtime it is unreachable, and throws if that assumption is ever wrong.
 */
function assertNeverToolId(id: never): never {
  throw new Error(`Unhandled session tool: ${String(id)}`);
}

export interface UseSessionToolsInput {
  projectId: string;
  session: ChatSessionResponse | null;
  sessionState: SessionState;
  taskEmbed: ChatSessionResponse['task'] | null;
  unresolvedCommentCount: number;
  needsAttentionCommentCount: number;
  onSessionMutated?: () => void;
  onOpenFiles?: () => void;
  onOpenGit?: () => void;
  onOpenTimeline?: () => void;
  onOpenComments?: () => void;
  onRetry?: () => void;
  onFork?: () => void;
}

export interface UseSessionToolsResult {
  mode: ToolStripMode;
  cycleMode: () => void;
  setMode: (mode: ToolStripMode) => void;
  actions: SessionToolAction[];
  selectTool: (id: SessionToolId) => void;
  /** Details-panel visibility — the rail's "Details" action toggles this. */
  detailsExpanded: boolean;
  setDetailsExpanded: (expanded: boolean) => void;
  reportOpen: boolean;
  closeReport: () => void;
  confirmCompleteOpen: boolean;
  closeConfirmComplete: () => void;
  confirmComplete: () => Promise<void>;
  completeError: string | null;
  dismissCompleteError: () => void;
}

export function useSessionTools(input: UseSessionToolsInput): UseSessionToolsResult {
  const {
    projectId,
    session,
    sessionState,
    taskEmbed,
    unresolvedCommentCount,
    needsAttentionCommentCount,
    onSessionMutated,
    onOpenFiles,
    onOpenGit,
    onOpenTimeline,
    onOpenComments,
    onRetry,
    onFork,
  } = input;

  const [mode, setMode] = useState<ToolStripMode>(readStoredMode);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [confirmCompleteOpen, setConfirmCompleteOpen] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);

  const [reportEnabled, setReportEnabled] = useState<boolean | null>(null);
  const reportConfigFetchedRef = useRef(false);

  useEffect(() => {
    if (reportConfigFetchedRef.current) return;
    reportConfigFetchedRef.current = true;
    getReportIssueConfig()
      .then((config) => setReportEnabled(config.enabled))
      .catch(() => setReportEnabled(false));
  }, []);

  /**
   * Sets the mode and remembers it.
   *
   * The write deliberately sits here rather than inside a `setMode` updater callback:
   * React invokes updaters twice under StrictMode, and a `localStorage` write is a side
   * effect that has no business running during render.
   */
  const selectMode = useCallback((next: ToolStripMode) => {
    setMode(next);
    try {
      window.localStorage.setItem(TOOL_STRIP_MODE_STORAGE_KEY, next);
    } catch {
      // Non-fatal: the mode just will not survive a reload.
    }
  }, []);

  const cycleMode = useCallback(() => {
    selectMode(nextToolStripMode(mode));
  }, [mode, selectMode]);

  const confirmComplete = useCallback(async () => {
    if (!taskEmbed?.id || completing) return;
    setCompleteError(null);
    setCompleting(true);
    setConfirmCompleteOpen(false);
    try {
      // Task completion snapshots and sleeps resumable sessions server-side.
      // Destructive workspace deletion belongs only to the explicit archive/delete flow.
      await updateProjectTaskStatus(projectId, taskEmbed.id, { toStatus: 'completed' });
      // Reset before the callback so the button is not stuck in "Completing..." if the
      // parent's refresh is slower than expected.
      setCompleting(false);
      onSessionMutated?.();
    } catch (err) {
      console.error('Failed to mark task complete:', err);
      setCompleteError(err instanceof Error ? err.message : 'Failed to complete task');
      setCompleting(false);
    }
  }, [projectId, taskEmbed?.id, completing, onSessionMutated]);

  // Memoized: an inline array would hand the rail a new prop identity on every poll
  // tick, remounting the whole strip mid-interaction (rule 64).
  const actions = useMemo<SessionToolAction[]>(() => {
    if (!session) return [];
    return buildSessionToolActions({
      session,
      sessionState,
      taskEmbed,
      reportEnabled,
      unresolvedCommentCount,
      needsAttentionCommentCount,
      hasFilesHandler: !!onOpenFiles,
      hasGitHandler: !!onOpenGit,
      hasTimelineHandler: !!onOpenTimeline,
      hasCommentsHandler: !!onOpenComments,
      hasRetryHandler: !!onRetry,
      hasForkHandler: !!onFork,
      completing,
      detailsExpanded,
    });
  }, [
    session,
    sessionState,
    taskEmbed,
    reportEnabled,
    unresolvedCommentCount,
    needsAttentionCommentCount,
    onOpenFiles,
    onOpenGit,
    onOpenTimeline,
    onOpenComments,
    onRetry,
    onFork,
    completing,
    detailsExpanded,
  ]);

  const selectTool = useCallback(
    (id: SessionToolId) => {
      switch (id) {
        case 'files':
          onOpenFiles?.();
          break;
        case 'git':
          onOpenGit?.();
          break;
        case 'timeline':
          onOpenTimeline?.();
          break;
        case 'comments':
          onOpenComments?.();
          break;
        case 'retry':
          onRetry?.();
          break;
        case 'fork':
          onFork?.();
          break;
        case 'report':
          setReportOpen(true);
          break;
        case 'complete':
          setConfirmCompleteOpen(true);
          break;
        case 'details':
          setDetailsExpanded((v) => !v);
          break;
        case 'workspace':
          // Rendered as an anchor by the rail — navigation is the browser's job.
          break;
        default:
          // Adding a `SessionToolId` without a case here would otherwise ship a control
          // that silently does nothing when clicked. Assigning to `never` makes it a
          // compile error instead.
          assertNeverToolId(id);
      }
    },
    [onOpenFiles, onOpenGit, onOpenTimeline, onOpenComments, onRetry, onFork]
  );

  const closeReport = useCallback(() => setReportOpen(false), []);
  const closeConfirmComplete = useCallback(() => setConfirmCompleteOpen(false), []);
  const dismissCompleteError = useCallback(() => setCompleteError(null), []);

  return {
    mode,
    cycleMode,
    setMode: selectMode,
    actions,
    selectTool,
    detailsExpanded,
    setDetailsExpanded,
    reportOpen,
    closeReport,
    confirmCompleteOpen,
    closeConfirmComplete,
    confirmComplete,
    completeError,
    dismissCompleteError,
  };
}
