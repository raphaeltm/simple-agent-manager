import { type CSSProperties, useEffect, useRef, useState, useMemo } from 'react';
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
          <span key={i} style={{ color: 'var(--sam-color-tn-blue)', fontWeight: 600 }}>
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

  const backdropStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'var(--sam-color-bg-overlay)',
    zIndex: 'var(--sam-z-dialog-backdrop)' as unknown as number,
  };

  const dialogStyle: CSSProperties = {
    position: 'fixed',
    top: '20%',
    left: '50%',
    transform: 'translateX(-50%)',
    width: '90vw',
    maxWidth: 480,
    backgroundColor: 'var(--sam-color-tn-surface)',
    border: '1px solid var(--sam-color-tn-border)',
    borderRadius: 12,
    boxShadow: 'var(--sam-shadow-overlay)',
    zIndex: 'var(--sam-z-command-palette)' as unknown as number,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  };

  const inputStyle: CSSProperties = {
    width: '100%',
    padding: '12px 16px',
    backgroundColor: 'transparent',
    border: 'none',
    borderBottom: '1px solid var(--sam-color-tn-border)',
    color: 'var(--sam-color-tn-fg)',
    fontSize: 'var(--sam-type-secondary-size)',
    outline: 'none',
    fontFamily: 'inherit',
  };

  const listStyle: CSSProperties = {
    maxHeight: 360,
    overflowY: 'auto',
    padding: '4px 0',
  };

  const categoryHeaderStyle: CSSProperties = {
    padding: '6px 16px 4px',
    fontSize: 'var(--sam-type-caption-size)',
    fontWeight: 600,
    color: 'var(--sam-color-tn-fg-dim)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    userSelect: 'none',
  };

  return (
    <>
      <div onClick={onClose} style={backdropStyle} />

      <div role="dialog" aria-label="Command palette" style={dialogStyle}>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search tabs, files, or commands..."
          style={inputStyle}
          aria-label="Search tabs, files, and commands"
          autoComplete="off"
          spellCheck={false}
        />

        <div role="listbox" style={listStyle}>
          {flatResults.length === 0 && !fileIndexLoading && (
            <div
              style={{
                padding: '16px',
                textAlign: 'center',
                color: 'var(--sam-color-tn-fg-muted)',
                fontSize: 'var(--sam-type-caption-size)',
              }}
            >
              No matching results
            </div>
          )}

          {fileIndexLoading && query && flatResults.length === 0 && (
            <div
              style={{
                padding: '16px',
                textAlign: 'center',
                color: 'var(--sam-color-tn-fg-muted)',
                fontSize: 'var(--sam-type-caption-size)',
              }}
            >
              Loading files...
            </div>
          )}

          {groups.map((group) => (
            <div key={group.category}>
              <div style={categoryHeaderStyle}>{group.category}</div>

              {group.results.map((result) => {
                flatIndex++;
                const currentFlatIndex = flatIndex;
                const isSelected = currentFlatIndex === selectedIndex;
                const itemStyle: CSSProperties = {
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '7px 16px',
                  cursor: 'pointer',
                  backgroundColor: isSelected ? 'var(--sam-color-tn-selected)' : 'transparent',
                  transition: 'background-color 0.1s',
                  gap: 12,
                };

                return (
                  <div
                    key={resultKey(result)}
                    ref={isSelected ? selectedRef : undefined}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => executeResult(result)}
                    onMouseEnter={() => setSelectedIndex(currentFlatIndex)}
                    style={itemStyle}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
                      <span style={{ fontSize: 'var(--sam-type-caption-size)', flexShrink: 0 }}>
                        {resultIcon(result)}
                      </span>
                      <span
                        style={{
                          fontSize: 'var(--sam-type-caption-size)',
                          color: 'var(--sam-color-tn-fg)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        <HighlightedText text={result.label} matches={result.matches} />
                      </span>
                    </div>
                    {result.kind === 'command' && (
                      <kbd
                        style={{
                          fontFamily: 'monospace',
                          fontSize: 'var(--sam-type-caption-size)',
                          color: 'var(--sam-color-tn-fg-bright)',
                          backgroundColor: 'var(--sam-color-tn-selected)',
                          border: '1px solid var(--sam-color-tn-border-highlight)',
                          borderRadius: 4,
                          padding: '2px 8px',
                          whiteSpace: 'nowrap',
                          flexShrink: 0,
                        }}
                      >
                        {result.shortcutKey}
                      </kbd>
                    )}
                    {result.kind === 'tab' && (
                      <span
                        style={{
                          fontSize: 'var(--sam-type-caption-size)',
                          color: 'var(--sam-color-tn-fg-dim)',
                          flexShrink: 0,
                        }}
                      >
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
