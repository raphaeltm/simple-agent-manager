import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { getPaletteShortcuts, formatShortcut } from '../lib/keyboard-shortcuts';
import type { ShortcutDefinition } from '../lib/keyboard-shortcuts';

interface CommandPaletteProps {
  onClose: () => void;
  handlers: Record<string, () => void>;
}

const paletteShortcuts = getPaletteShortcuts();

function displayLabel(shortcut: ShortcutDefinition): string {
  if (shortcut.id === 'tab-1') return 'Switch to tab 1\u20139';
  return shortcut.description;
}

function displayShortcutKey(shortcut: ShortcutDefinition): string {
  if (shortcut.id === 'tab-1') return formatShortcut(shortcut).replace('1', '1\u20139');
  return formatShortcut(shortcut);
}

/**
 * VS Code-style command palette overlay. Lists all shortcut-backed actions
 * with substring search filtering and keyboard navigation.
 */
export function CommandPalette({ onClose, handlers }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = query
    ? paletteShortcuts.filter((s) =>
        displayLabel(s).toLowerCase().includes(query.toLowerCase())
      )
    : paletteShortcuts;

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

  const execute = (shortcut: ShortcutDefinition) => {
    const handler = handlers[shortcut.id];
    if (handler) handler();
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (filtered[selectedIndex]) {
          execute(filtered[selectedIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        onClose();
        break;
    }
  };

  const backdropStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    zIndex: 61,
  };

  const dialogStyle: CSSProperties = {
    position: 'fixed',
    top: '20%',
    left: '50%',
    transform: 'translateX(-50%)',
    width: '90vw',
    maxWidth: 480,
    backgroundColor: '#1e2030',
    border: '1px solid #2a2d3a',
    borderRadius: 12,
    boxShadow: '0 20px 60px rgba(0, 0, 0, 0.5)',
    zIndex: 62,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  };

  const inputStyle: CSSProperties = {
    width: '100%',
    padding: '12px 16px',
    backgroundColor: 'transparent',
    border: 'none',
    borderBottom: '1px solid #2a2d3a',
    color: '#a9b1d6',
    fontSize: '0.875rem',
    outline: 'none',
    fontFamily: 'inherit',
  };

  const listStyle: CSSProperties = {
    maxHeight: 300,
    overflowY: 'auto',
    padding: '4px 0',
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
          placeholder="Type a command..."
          style={inputStyle}
          aria-label="Search commands"
          autoComplete="off"
          spellCheck={false}
        />

        <div ref={listRef} role="listbox" style={listStyle}>
          {filtered.length === 0 && (
            <div
              style={{
                padding: '16px',
                textAlign: 'center',
                color: '#787c99',
                fontSize: '0.8125rem',
              }}
            >
              No matching commands
            </div>
          )}
          {filtered.map((shortcut, index) => {
            const isSelected = index === selectedIndex;
            const itemStyle: CSSProperties = {
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '8px 16px',
              cursor: 'pointer',
              backgroundColor: isSelected ? '#292e42' : 'transparent',
              transition: 'background-color 0.1s',
            };

            return (
              <div
                key={shortcut.id}
                ref={isSelected ? selectedRef : undefined}
                role="option"
                aria-selected={isSelected}
                onClick={() => execute(shortcut)}
                onMouseEnter={() => setSelectedIndex(index)}
                style={itemStyle}
              >
                <span
                  style={{
                    fontSize: '0.8125rem',
                    color: '#a9b1d6',
                  }}
                >
                  {displayLabel(shortcut)}
                </span>
                <kbd
                  style={{
                    fontFamily: 'monospace',
                    fontSize: '0.75rem',
                    color: '#c0caf5',
                    backgroundColor: '#292e42',
                    border: '1px solid #3b4261',
                    borderRadius: 4,
                    padding: '2px 8px',
                    whiteSpace: 'nowrap',
                    marginLeft: 16,
                  }}
                >
                  {displayShortcutKey(shortcut)}
                </kbd>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
