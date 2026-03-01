import { useEffect, useRef, useState, useMemo } from 'react';
import { getPaletteShortcuts, formatShortcut } from '../lib/keyboard-shortcuts';
import type { ShortcutDefinition } from '../lib/keyboard-shortcuts';
import { fuzzyMatch, fileNameFromPath, type FuzzyMatchResult } from '../lib/fuzzy-match';
import type { WorkspaceTabItem } from './WorkspaceTabStrip';

// ── Result types ──

interface TabResult {
  kind: 'tab';
  tab: WorkspaceTabItem;
  label: string;
  score: number;
  matches: number[];
}

interface FileResult {
  kind: 'file';
  path: string;
  label: string;
  score: number;
  matches: number[];
}

interface CommandResult {
  kind: 'command';
  shortcut: ShortcutDefinition;
  label: string;
  score: number;
  matches: number[];
  shortcutKey: string;
}

type PaletteResult = TabResult | FileResult | CommandResult;

interface CategoryGroup {
  category: 'Tabs' | 'Files' | 'Commands';
  results: PaletteResult[];
}

// ── Props ──

interface CommandPaletteProps {
  onClose: () => void;
  handlers: Record<string, () => void>;
  tabs?: WorkspaceTabItem[];
  fileIndex?: string[];
  fileIndexLoading?: boolean;
  onSelectTab?: (tab: WorkspaceTabItem) => void;
  onSelectFile?: (path: string) => void;
}

// ── Helpers ──

const paletteShortcuts = getPaletteShortcuts();

function displayLabel(shortcut: ShortcutDefinition): string {
  if (shortcut.id === 'tab-1') return 'Switch to tab 1\u20139';
  return shortcut.description;
}

function displayShortcutKey(shortcut: ShortcutDefinition): string {
  if (shortcut.id === 'tab-1') return formatShortcut(shortcut).replace('1', '1\u20139');
  return formatShortcut(shortcut);
}

function buildResults(
  query: string,
  tabs: WorkspaceTabItem[],
  fileIndex: string[],
): CategoryGroup[] {
  const groups: CategoryGroup[] = [];

  // ── Tabs ──
  const tabResults: TabResult[] = [];
  for (const tab of tabs) {
    if (!query) {
      tabResults.push({ kind: 'tab', tab, label: tab.title, score: 0, matches: [] });
    } else {
      const m = fuzzyMatch(query, tab.title);
      if (m) {
        tabResults.push({ kind: 'tab', tab, label: tab.title, score: m.score, matches: m.matches });
      }
    }
  }
  tabResults.sort((a, b) => b.score - a.score);
  if (tabResults.length > 0) {
    groups.push({ category: 'Tabs', results: tabResults });
  }

  // ── Files ──
  if (fileIndex.length > 0) {
    const fileResults: FileResult[] = [];
    for (const path of fileIndex) {
      if (!query) continue; // Don't show files on empty query (too many)
      // Match against full path and filename — take the better score
      const pathMatch = fuzzyMatch(query, path);
      const fileName = fileNameFromPath(path);
      const nameMatch = fuzzyMatch(query, fileName);
      let best: FuzzyMatchResult | null = null;
      if (pathMatch && nameMatch) {
        if (nameMatch.score >= pathMatch.score) {
          // Prefer name match but adjust indices to reference full path
          const offset = path.length - fileName.length;
          best = { score: nameMatch.score, matches: nameMatch.matches.map((i) => i + offset) };
        } else {
          best = pathMatch;
        }
      } else {
        best = pathMatch ?? nameMatch
          ? (nameMatch ? {
              score: nameMatch!.score,
              matches: nameMatch!.matches.map((i) => i + path.length - fileName.length),
            } : pathMatch)
          : null;
      }
      if (best) {
        fileResults.push({ kind: 'file', path, label: path, score: best.score, matches: best.matches });
      }
    }
    fileResults.sort((a, b) => b.score - a.score);
    // Cap to top 20 file results for performance
    const cappedFiles = fileResults.slice(0, 20);
    if (cappedFiles.length > 0) {
      groups.push({ category: 'Files', results: cappedFiles });
    }
  }

  // ── Commands ──
  const cmdResults: CommandResult[] = [];
  for (const shortcut of paletteShortcuts) {
    const label = displayLabel(shortcut);
    if (!query) {
      cmdResults.push({
        kind: 'command',
        shortcut,
        label,
        score: 0,
        matches: [],
        shortcutKey: displayShortcutKey(shortcut),
      });
    } else {
      const m = fuzzyMatch(query, label);
      if (m) {
        cmdResults.push({
          kind: 'command',
          shortcut,
          label,
          score: m.score,
          matches: m.matches,
          shortcutKey: displayShortcutKey(shortcut),
        });
      }
    }
  }
  cmdResults.sort((a, b) => b.score - a.score);
  if (cmdResults.length > 0) {
    groups.push({ category: 'Commands', results: cmdResults });
  }

  return groups;
}

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
          <span key={i} className="text-tn-blue font-semibold">
            {part.text}
          </span>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
    </>
  );
}

// ── Component ──

/**
 * VS Code-style command palette with fuzzy search across tabs, files, and commands.
 */
export function CommandPalette({
  onClose,
  handlers,
  tabs = [],
  fileIndex = [],
  fileIndexLoading = false,
  onSelectTab,
  onSelectFile,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(
    () => buildResults(query, tabs, fileIndex),
    [query, tabs, fileIndex]
  );

  // Flatten all results for keyboard navigation
  const flatResults = useMemo(() => {
    const flat: PaletteResult[] = [];
    for (const group of groups) {
      flat.push(...group.results);
    }
    return flat;
  }, [groups]);

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

  const executeResult = (result: PaletteResult) => {
    switch (result.kind) {
      case 'tab':
        if (onSelectTab) onSelectTab(result.tab);
        break;
      case 'file':
        if (onSelectFile) onSelectFile(result.path);
        break;
      case 'command': {
        const handler = handlers[result.shortcut.id];
        if (handler) handler();
        break;
      }
    }
    onClose();
  };

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

  // Track the flat index for rendering
  let flatIndex = -1;

  return (
    <>
      <div onClick={onClose} className="fixed inset-0 bg-overlay z-dialog-backdrop" />

      <div
        role="dialog"
        aria-label="Command palette"
        className="fixed top-[20%] left-1/2 -translate-x-1/2 w-[90vw] max-w-[480px] bg-tn-surface border border-tn-border rounded-xl shadow-overlay z-command-palette flex flex-col overflow-hidden"
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search tabs, files, or commands..."
          className="w-full px-4 py-3 bg-transparent border-none border-b border-tn-border text-tn-fg text-sm outline-none font-[inherit]"
          aria-label="Search tabs, files, and commands"
          autoComplete="off"
          spellCheck={false}
        />

        <div role="listbox" className="max-h-90 overflow-y-auto py-1">
          {flatResults.length === 0 && !fileIndexLoading && (
            <div className="p-4 text-center text-tn-fg-muted text-xs">
              No matching results
            </div>
          )}

          {fileIndexLoading && query && flatResults.length === 0 && (
            <div className="p-4 text-center text-tn-fg-muted text-xs">
              Loading files...
            </div>
          )}

          {groups.map((group) => (
            <div key={group.category}>
              <div className="px-4 pt-1.5 pb-1 text-xs font-semibold text-tn-fg-dim uppercase tracking-wide select-none">
                {group.category}
              </div>

              {group.results.map((result) => {
                flatIndex++;
                const currentFlatIndex = flatIndex;
                const isSelected = currentFlatIndex === selectedIndex;

                return (
                  <div
                    key={resultKey(result)}
                    ref={isSelected ? selectedRef : undefined}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => executeResult(result)}
                    onMouseEnter={() => setSelectedIndex(currentFlatIndex)}
                    className={`flex justify-between items-center px-4 py-[7px] cursor-pointer gap-3 transition-colors duration-100 ${
                      isSelected ? 'bg-tn-selected' : 'bg-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className="text-xs shrink-0">
                        {resultIcon(result)}
                      </span>
                      <span className="text-xs text-tn-fg overflow-hidden text-ellipsis whitespace-nowrap">
                        <HighlightedText text={result.label} matches={result.matches} />
                      </span>
                    </div>
                    {result.kind === 'command' && (
                      <kbd className="font-mono text-xs text-tn-fg-bright bg-tn-selected border border-tn-border-highlight rounded px-2 py-0.5 whitespace-nowrap shrink-0">
                        {result.shortcutKey}
                      </kbd>
                    )}
                    {result.kind === 'tab' && (
                      <span className="text-xs text-tn-fg-dim shrink-0">
                        {result.tab.kind === 'terminal' ? 'terminal' : 'chat'}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ── Helpers ──

function resultKey(result: PaletteResult): string {
  switch (result.kind) {
    case 'tab': return `tab:${result.tab.id}`;
    case 'file': return `file:${result.path}`;
    case 'command': return `cmd:${result.shortcut.id}`;
  }
}

function resultIcon(result: PaletteResult): string {
  switch (result.kind) {
    case 'tab':
      return result.tab.kind === 'terminal' ? '>' : '#';
    case 'file':
      return '~';
    case 'command':
      return '/';
  }
}
