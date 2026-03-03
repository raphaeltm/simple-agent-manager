import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Home,
  FolderKanban,
  Server,
  Settings,
  Shield,
  Plus,
  MessageSquarePlus,
  Search,
  ArrowRight,
} from 'lucide-react';
import { fuzzyMatch } from '../lib/fuzzy-match';
import { useAuth } from './AuthProvider';
import { listProjects, listNodes } from '../lib/api';
import { isMacPlatform } from '../lib/keyboard-shortcuts';

// ── Configurable limits ──

const DEFAULT_PROJECT_FETCH_LIMIT = 50;
const DEFAULT_MAX_RESULTS_PER_CATEGORY = 10;

const PROJECT_FETCH_LIMIT = parseInt(
  import.meta.env.VITE_CMD_PALETTE_PROJECT_FETCH_LIMIT ||
    String(DEFAULT_PROJECT_FETCH_LIMIT),
);
const MAX_RESULTS_PER_CATEGORY = parseInt(
  import.meta.env.VITE_CMD_PALETTE_MAX_RESULTS_PER_CATEGORY ||
    String(DEFAULT_MAX_RESULTS_PER_CATEGORY),
);

// ── Result types ──

interface NavigationResult {
  kind: 'navigation';
  id: string;
  label: string;
  path: string;
  icon: React.ReactNode;
  score: number;
  matches: number[];
}

interface ProjectResult {
  kind: 'project';
  id: string;
  label: string;
  path: string;
  score: number;
  matches: number[];
}

interface NodeResult {
  kind: 'node';
  id: string;
  label: string;
  path: string;
  score: number;
  matches: number[];
}

interface ActionResult {
  kind: 'action';
  id: string;
  label: string;
  action: () => void;
  icon: React.ReactNode;
  score: number;
  matches: number[];
}

type PaletteResult = NavigationResult | ProjectResult | NodeResult | ActionResult;

interface CategoryGroup {
  category: string;
  results: PaletteResult[];
}

// ── Props ──

interface GlobalCommandPaletteProps {
  onClose: () => void;
}

// ── Helpers ──

/** Render text with matched character indices highlighted. */
function HighlightedText({ text, matches }: { text: string; matches: number[] }) {
  if (matches.length === 0) return <>{text}</>;

  const matchSet = new Set(matches);
  const parts: Array<{ text: string; highlighted: boolean }> = [];
  let current = '';
  let currentHighlighted = false;

  for (let i = 0; i < text.length; i++) {
    const isMatch = matchSet.has(i);
    if (i === 0) {
      currentHighlighted = isMatch;
      current = text[i]!;
    } else if (isMatch === currentHighlighted) {
      current += text[i];
    } else {
      parts.push({ text: current, highlighted: currentHighlighted });
      current = text[i]!;
      currentHighlighted = isMatch;
    }
  }
  if (current) parts.push({ text: current, highlighted: currentHighlighted });

  return (
    <>
      {parts.map((part, i) =>
        part.highlighted ? (
          <span key={i} className="text-accent font-semibold">
            {part.text}
          </span>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

function resultKey(result: PaletteResult): string {
  return `${result.kind}:${result.id}`;
}

// ── Component ──

export function GlobalCommandPalette({ onClose }: GlobalCommandPaletteProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { isSuperadmin } = useAuth();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Dynamic data
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [nodes, setNodes] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);

  // Fetch projects and nodes on mount
  useEffect(() => {
    let cancelled = false;
    async function fetchData() {
      try {
        const [projectsRes, nodesRes] = await Promise.all([
          listProjects(PROJECT_FETCH_LIMIT).catch(() => ({ projects: [] as Array<{ id: string; name: string }> })),
          listNodes().catch(() => [] as Array<{ id: string; name: string }>),
        ]);
        if (!cancelled) {
          const projectList = 'projects' in projectsRes ? projectsRes.projects : [];
          setProjects(projectList.map((p: { id: string; name: string }) => ({ id: p.id, name: p.name })));
          const nodeList = Array.isArray(nodesRes) ? nodesRes : [];
          setNodes(nodeList.map((n: { id: string; name: string }) => ({ id: n.id, name: n.name })));
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    }
    fetchData();
    return () => { cancelled = true; };
  }, []);

  // Build navigation items
  const navigationItems = useMemo(() => {
    const items: Array<{ id: string; label: string; path: string; icon: React.ReactNode }> = [
      { id: 'nav-dashboard', label: 'Dashboard', path: '/dashboard', icon: <Home size={14} /> },
      { id: 'nav-projects', label: 'Projects', path: '/projects', icon: <FolderKanban size={14} /> },
      { id: 'nav-nodes', label: 'Nodes', path: '/nodes', icon: <Server size={14} /> },
      { id: 'nav-settings', label: 'Settings', path: '/settings', icon: <Settings size={14} /> },
    ];
    if (isSuperadmin) {
      items.push({ id: 'nav-admin', label: 'Admin', path: '/admin', icon: <Shield size={14} /> });
    }
    return items;
  }, [isSuperadmin]);

  // Build action items
  const actionItems = useMemo(() => {
    const items: Array<{ id: string; label: string; action: () => void; icon: React.ReactNode }> = [
      {
        id: 'action-new-project',
        label: 'New Project',
        action: () => navigate('/projects/new'),
        icon: <Plus size={14} />,
      },
    ];
    return items;
  }, [navigate]);

  // Build results with fuzzy matching
  const groups = useMemo(() => {
    const result: CategoryGroup[] = [];

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
      const capped = projectResults.slice(0, MAX_RESULTS_PER_CATEGORY);
      if (capped.length > 0) {
        result.push({ category: 'Projects', results: capped });
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
            action: () => navigate(`/projects/${projectId}/chat`, { state: { newChat: true } }),
            icon: <MessageSquarePlus size={14} />,
            score: m.score,
            matches: m.matches,
          });
        }
      }
      quickActionResults.sort((a, b) => b.score - a.score);
      const cappedQuickActions = quickActionResults.slice(0, MAX_RESULTS_PER_CATEGORY);
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
      const capped = nodeResults.slice(0, MAX_RESULTS_PER_CATEGORY);
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
  }, [query, navigationItems, projects, nodes, actionItems]);

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
    [navigate, location.pathname, onClose],
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
      case 'node':
        return <Server size={14} />;
      case 'action':
        return result.icon;
    }
  };

  // Track flat index for rendering
  let flatIndex = -1;

  const modKey = isMacPlatform() ? '\u2318' : 'Ctrl';

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} className="fixed inset-0 bg-overlay z-dialog-backdrop" />

      {/* Palette dialog */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-label="Command palette"
        aria-modal="true"
        className="fixed top-[20%] left-1/2 -translate-x-1/2 w-[90vw] max-w-[480px] bg-surface border border-border-default rounded-lg shadow-overlay z-command-palette flex flex-col overflow-hidden"
      >
        {/* Search input */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-default">
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
            placeholder="Search pages, projects, nodes..."
            className="w-full bg-transparent border-none text-fg-primary text-sm outline-none font-[inherit] placeholder:text-fg-muted focus:ring-0"
            aria-label="Search pages, projects, and nodes"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="font-mono text-[10px] text-fg-muted bg-inset border border-border-default rounded px-1.5 py-0.5 whitespace-nowrap shrink-0">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div role="listbox" id="gcp-listbox" aria-label="Command palette results" className="max-h-[360px] overflow-y-auto py-1">
          {flatResults.length === 0 && !loading && (
            <div className="p-4 text-center text-fg-muted text-xs">No matching results</div>
          )}

          {loading && flatResults.length === 0 && (
            <div className="p-4 text-center text-fg-muted text-xs">Loading...</div>
          )}

          {groups.map((group) => (
            <div key={group.category} role="group" aria-labelledby={`gcp-category-${group.category}`}>
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
                    onClick={() => executeResult(result)}
                    onMouseEnter={() => setSelectedIndex(currentFlatIndex)}
                    className={`flex items-center gap-3 px-4 py-2 cursor-pointer transition-colors duration-100 ${
                      isSelected ? 'bg-surface-hover' : 'bg-transparent'
                    }`}
                  >
                    <span className="text-fg-muted shrink-0">{iconForResult(result)}</span>
                    <span className="text-sm text-fg-primary overflow-hidden text-ellipsis whitespace-nowrap flex-1">
                      <HighlightedText text={result.label} matches={result.matches} />
                    </span>
                    {isSelected && (
                      <ArrowRight size={12} className="text-fg-muted shrink-0" />
                    )}
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
              <kbd className="font-mono bg-inset border border-border-default rounded px-1 py-0.5">&uarr;</kbd>
              <kbd className="font-mono bg-inset border border-border-default rounded px-1 py-0.5">&darr;</kbd>
              <span>navigate</span>
            </span>
            <span className="flex items-center gap-1">
              <kbd className="font-mono bg-inset border border-border-default rounded px-1 py-0.5">&crarr;</kbd>
              <span>open</span>
            </span>
          </div>
          <kbd className="font-mono bg-inset border border-border-default rounded px-1 py-0.5">
            {modKey}K
          </kbd>
        </div>
      </div>
    </>
  );
}
