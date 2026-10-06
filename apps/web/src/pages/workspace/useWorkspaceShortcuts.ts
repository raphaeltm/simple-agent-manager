import type { AgentInfo, AgentType, WorktreeInfo } from '@simple-agent-manager/shared';
import type { MultiTerminalHandle } from '@simple-agent-manager/terminal';
import type { Dispatch, RefObject, SetStateAction } from 'react';

import type { ChatSessionHandle } from '../../components/ChatSession';
import type { ShortcutHandlers } from '../../hooks/useKeyboardShortcuts';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import type { ViewMode, WorkspaceTab } from './types';

export interface UseWorkspaceShortcutsParams {
  isRunning: boolean;
  terminalToken: string | null;
  filesParam: string | null;
  gitParam: string | null;
  handleCloseFileBrowser: () => void;
  handleOpenFileBrowser: () => void;
  handleCloseGitPanel: () => void;
  handleOpenGitChanges: () => void;
  worktrees: WorktreeInfo[];
  activeChatSessionId: string | null;
  handleAttachSession: (sessionId: string) => void;
  handleCreateSession: (preferredAgentId?: AgentInfo['id']) => Promise<void>;
  defaultAgentId: AgentType | null;
  viewMode: ViewMode;
  chatSessionRefs: RefObject<Map<string, ChatSessionHandle>>;
  workspaceTabs: WorkspaceTab[];
  activeTabId: string | null;
  handleSelectWorkspaceTab: (tab: WorkspaceTab) => void;
  multiTerminalRef: RefObject<MultiTerminalHandle | null>;
  handleCreateTerminalTab: () => void;
  setShowCommandPalette: Dispatch<SetStateAction<boolean>>;
  setShowShortcutsHelp: Dispatch<SetStateAction<boolean>>;
}

/**
 * Builds the workspace's global keyboard-shortcut handler map and registers
 * it via useKeyboardShortcuts. Returns the same handler map so the parent can
 * reuse it for the command palette's action list.
 */
export function useWorkspaceShortcuts(input: UseWorkspaceShortcutsParams): ShortcutHandlers {
  const {
    isRunning,
    terminalToken,
    filesParam,
    gitParam,
    handleCloseFileBrowser,
    handleOpenFileBrowser,
    handleCloseGitPanel,
    handleOpenGitChanges,
    worktrees,
    activeChatSessionId,
    handleAttachSession,
    handleCreateSession,
    defaultAgentId,
    viewMode,
    chatSessionRefs,
    workspaceTabs,
    activeTabId,
    handleSelectWorkspaceTab,
    multiTerminalRef,
    handleCreateTerminalTab,
    setShowCommandPalette,
    setShowShortcutsHelp,
  } = input;

  const shortcutHandlers: ShortcutHandlers = {
    'toggle-file-browser': () => {
      if (isRunning && terminalToken) {
        filesParam ? handleCloseFileBrowser() : handleOpenFileBrowser();
      }
    },
    'toggle-git-changes': () => {
      if (isRunning && terminalToken) {
        gitParam ? handleCloseGitPanel() : handleOpenGitChanges();
      }
    },
    'focus-chat': () => {
      const sessionId = activeChatSessionId;
      if (sessionId) {
        if (viewMode !== 'conversation') handleAttachSession(sessionId);
        requestAnimationFrame(() => chatSessionRefs.current.get(sessionId)?.focusInput());
      }
    },
    'focus-terminal': () => {
      if (viewMode !== 'terminal') {
        const ft = workspaceTabs.find((t) => t.kind === 'terminal');
        if (ft) handleSelectWorkspaceTab(ft);
      }
      requestAnimationFrame(() => multiTerminalRef.current?.focus());
    },
    'switch-worktree': () => {
      if (isRunning && worktrees.length > 0)
        document.getElementById('worktree-selector-trigger')?.click();
    },
    'next-tab': () => {
      if (workspaceTabs.length > 1) {
        const ci = workspaceTabs.findIndex((t) => t.id === activeTabId);
        const nextTab = workspaceTabs[(ci + 1) % workspaceTabs.length];
        if (nextTab) handleSelectWorkspaceTab(nextTab);
      }
    },
    'prev-tab': () => {
      if (workspaceTabs.length > 1) {
        const ci = workspaceTabs.findIndex((t) => t.id === activeTabId);
        const prevTab = workspaceTabs[ci <= 0 ? workspaceTabs.length - 1 : ci - 1];
        if (prevTab) handleSelectWorkspaceTab(prevTab);
      }
    },
    ...Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [
        `tab-${i + 1}`,
        () => {
          if (i < workspaceTabs.length) {
            const tab = workspaceTabs[i];
            if (tab) handleSelectWorkspaceTab(tab);
          }
        },
      ])
    ),
    'new-chat': () => {
      if (isRunning) void handleCreateSession(defaultAgentId ?? undefined);
    },
    'new-terminal': () => {
      if (isRunning) handleCreateTerminalTab();
    },
    'command-palette': () => {
      setShowCommandPalette((p) => !p);
      setShowShortcutsHelp(false);
    },
    'show-shortcuts': () => setShowShortcutsHelp((p) => !p),
  };

  useKeyboardShortcuts(shortcutHandlers, isRunning);

  return shortcutHandlers;
}
