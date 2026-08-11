import { ArrowRight, FolderKanban, MessageSquare, Search, Server } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router';

import { useTheme } from '../contexts/ThemeContext';
import { useCommandPaletteContext } from '../hooks/useCommandPaletteContext';
import type { SessionSummaryItem } from '../lib/api';
import { getAllChats, listNodes, listProjects } from '../lib/api';
import { isMacPlatform } from '../lib/keyboard-shortcuts';
import { useAuth } from './AuthProvider';
import { buildActionItems } from './global-command-palette-action-items';
import { buildResultGroups } from './global-command-palette-groups';
import { HighlightedText } from './global-command-palette-highlighted-text';
import { buildNavigationItems } from './global-command-palette-navigation-items';
import type { PaletteResult } from './global-command-palette-types';
import { resultKey } from './global-command-palette-types';

// ── Configurable limits ──

const DEFAULT_PROJECT_FETCH_LIMIT = 50;
const DEFAULT_MAX_RESULTS_PER_CATEGORY = 10;

const PROJECT_FETCH_LIMIT = parseInt(
  import.meta.env.VITE_CMD_PALETTE_PROJECT_FETCH_LIMIT || String(DEFAULT_PROJECT_FETCH_LIMIT)
);
const MAX_RESULTS_PER_CATEGORY = parseInt(
  import.meta.env.VITE_CMD_PALETTE_MAX_RESULTS_PER_CATEGORY ||
    String(DEFAULT_MAX_RESULTS_PER_CATEGORY)
);

// ── Props ──

interface GlobalCommandPaletteProps {
  onClose: () => void;
}

// ── Component ──

export function GlobalCommandPalette({ onClose }: GlobalCommandPaletteProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { isSuperadmin } = useAuth();
  const { isDark, setTheme } = useTheme();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Dynamic data
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [nodes, setNodes] = useState<Array<{ id: string; name: string }>>([]);
  const [chatSessions, setChatSessions] = useState<
    Array<SessionSummaryItem & { createdAt: number }>
  >([]);
  const [loading, setLoading] = useState(true);

  // Context-aware actions based on current URL
  const { context, contextActions } = useCommandPaletteContext({
    chatSessions,
    projects,
  });

  // Fetch projects, nodes, and chat sessions on mount
  useEffect(() => {
    let cancelled = false;
    async function fetchData() {
      try {
        const [projectsRes, nodesRes] = await Promise.all([
          listProjects(PROJECT_FETCH_LIMIT).catch(() => ({
            projects: [] as Array<{ id: string; name: string }>,
          })),
          listNodes().catch(() => [] as Array<{ id: string; name: string }>),
        ]);
        if (cancelled) return;

        const projectList = 'projects' in projectsRes ? projectsRes.projects : [];
        const mappedProjects = projectList.map((p: { id: string; name: string }) => ({
          id: p.id,
          name: p.name,
        }));
        setProjects(mappedProjects);

        const nodeList = Array.isArray(nodesRes) ? nodesRes : [];
        setNodes(nodeList.map((n: { id: string; name: string }) => ({ id: n.id, name: n.name })));

        // Fetch chat sessions via single D1 query (no DO fan-out)
        const chatsRes = await getAllChats({ limit: 100 }).catch(() => ({
          sessions: [],
          total: 0,
        }));
        if (!cancelled) {
          setChatSessions(chatsRes.sessions.map((s) => ({ ...s, createdAt: s.startedAt })));
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    }
    fetchData();
    return () => {
      cancelled = true;
    };
  }, []);

  // Build navigation items
  const navigationItems = useMemo(() => buildNavigationItems(isSuperadmin), [isSuperadmin]);

  // Build action items
  const actionItems = useMemo(
    () => buildActionItems({ navigate, isDark, setTheme }),
    [navigate, isDark, setTheme]
  );

  // Build results with fuzzy matching
  const groups = useMemo(
    () =>
      buildResultGroups({
        query,
        navigationItems,
        projects,
        nodes,
        chatSessions,
        actionItems,
        contextActions,
        currentProjectId: context.projectId,
        navigate,
        maxResultsPerCategory: MAX_RESULTS_PER_CATEGORY,
      }),
    [
      query,
      navigationItems,
      projects,
      nodes,
      chatSessions,
      actionItems,
      contextActions,
      context.projectId,
    ]
  );

  // Flatten results for keyboard navigation
  const flatResults = useMemo(() => {
    const flat: PaletteResult[] = [];
    for (const group of groups) {
      flat.push(...group.results);
    }
    return flat;
  }, [groups]);

  // Active descendant ID for ARIA
  const activeDescendantId = flatResults[selectedIndex]
    ? `gcp-option-${resultKey(flatResults[selectedIndex])}`
    : undefined;

  // Auto-focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Scroll selected item into view
  useEffect(() => {
    if (selectedRef.current && typeof selectedRef.current.scrollIntoView === 'function') {
      selectedRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // Focus trap — keep Tab within the dialog
  useEffect(() => {
    const handleTab = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        // Keep focus on the input — there's only one interactive element
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleTab);
    return () => window.removeEventListener('keydown', handleTab);
  }, []);

  const executeResult = useCallback(
    (result: PaletteResult) => {
      switch (result.kind) {
        case 'navigation':
        case 'project':
        case 'node':
        case 'chat':
          // Don't navigate if already on this path
          if (location.pathname !== result.path) {
            navigate(result.path);
          }
          break;
        case 'action':
          result.action();
          break;
      }
      onClose();
    },
    [navigate, location.pathname, onClose]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, flatResults.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (flatResults[selectedIndex]) {
          executeResult(flatResults[selectedIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
    }
  };

  const iconForResult = (result: PaletteResult): React.ReactNode => {
    switch (result.kind) {
      case 'navigation':
        return result.icon;
      case 'project':
        return <FolderKanban size={14} />;
      case 'chat':
        return <MessageSquare size={14} />;
      case 'node':
        return <Server size={14} />;
      case 'action':
        return result.icon;
    }
  };

  // Track flat index for rendering
  let flatIndex = -1;

  const modKey = isMacPlatform() ? '\u2318' : 'Ctrl';

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        aria-hidden="true"
        className="fixed inset-0 glass-backdrop-dim border-0 z-dialog-backdrop"
      />

      {/* Palette dialog */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-label="Command palette"
        aria-modal="true"
        className="glass-panel-container fixed top-[20%] left-1/2 -translate-x-1/2 w-[90vw] max-w-[480px] glass-modal rounded-lg shadow-overlay z-command-palette flex flex-col overflow-hidden"
      >
        {/* Search input */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-default bg-[rgba(0,0,0,0.2)]">
          <Search size={14} className="text-fg-muted shrink-0" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="gcp-listbox"
            aria-activedescendant={activeDescendantId}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search pages, projects, chats, nodes..."
            className="w-full bg-transparent border-none text-fg-primary text-sm outline-none font-[inherit] placeholder:text-fg-muted focus:ring-0"
            aria-label="Search pages, projects, chats, and nodes"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="font-mono text-[10px] text-fg-muted bg-inset border border-border-default rounded px-1.5 py-0.5 whitespace-nowrap shrink-0">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div
          role="listbox"
          id="gcp-listbox"
          aria-label="Command palette results"
          className="max-h-[360px] overflow-y-auto py-1"
        >
          {flatResults.length === 0 && !loading && (
            <div className="p-4 text-center text-fg-muted text-xs">No matching results</div>
          )}

          {loading && flatResults.length === 0 && (
            <div className="p-4 text-center text-fg-muted text-xs">Loading...</div>
          )}

          {groups.map((group) => (
            <div
              key={group.category}
              role="group"
              aria-labelledby={`gcp-category-${group.category}`}
            >
              <div
                id={`gcp-category-${group.category}`}
                className="px-4 pt-2 pb-1 text-[10px] font-semibold text-fg-muted uppercase tracking-wider select-none"
              >
                {group.category}
              </div>

              {group.results.map((result) => {
                flatIndex++;
                const currentFlatIndex = flatIndex;
                const isSelected = currentFlatIndex === selectedIndex;

                return (
                  <div
                    key={resultKey(result)}
                    id={`gcp-option-${resultKey(result)}`}
                    ref={isSelected ? selectedRef : undefined}
                    role="option"
                    aria-selected={isSelected}
                    aria-label={
                      result.kind === 'chat'
                        ? `${result.label}, ${result.projectName}`
                        : result.label
                    }
                    tabIndex={-1}
                    onClick={() => executeResult(result)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') executeResult(result);
                    }}
                    onMouseEnter={() => setSelectedIndex(currentFlatIndex)}
                    className={`flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors duration-100 ${
                      isSelected ? 'bg-[rgba(34,197,94,0.06)]' : 'bg-transparent'
                    }`}
                  >
                    <span className="text-fg-muted shrink-0">{iconForResult(result)}</span>
                    <span className="text-sm text-fg-primary min-w-0 overflow-hidden text-ellipsis whitespace-nowrap flex-1">
                      <HighlightedText text={result.label} matches={result.matches} />
                    </span>
                    {result.kind === 'chat' && (
                      <span className="text-xs text-fg-muted shrink-0 ml-1 max-w-[120px] overflow-hidden text-ellipsis whitespace-nowrap">
                        {result.projectName}
                      </span>
                    )}
                    {isSelected && <ArrowRight size={12} className="text-fg-muted shrink-0" />}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer hint */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-border-default text-[10px] text-fg-muted">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="font-mono bg-inset border border-border-default rounded px-1 py-0.5">
                &uarr;
              </kbd>
              <kbd className="font-mono bg-inset border border-border-default rounded px-1 py-0.5">
                &darr;
              </kbd>
              <span>navigate</span>
            </span>
            <span className="flex items-center gap-1">
              <kbd className="font-mono bg-inset border border-border-default rounded px-1 py-0.5">
                &crarr;
              </kbd>
              <span>open</span>
            </span>
          </div>
          <kbd className="font-mono bg-inset border border-border-default rounded px-1 py-0.5">
            {modKey}K
          </kbd>
        </div>
      </div>
    </>,
    document.body
  );
}
