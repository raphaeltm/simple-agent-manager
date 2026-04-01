import { forwardRef,useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

import type { SlashCommand } from '../types';

/** Maximum number of visible items before scrolling */
const MAX_VISIBLE_ITEMS = 8;

export interface SlashCommandPaletteProps {
  /** All commands (agent + client) to filter and display */
  commands: SlashCommand[];
  /** Text after the leading "/" to filter by (e.g., user typed "/co" -> filter = "co") */
  filter: string;
  /** Called when a command is selected (click or Enter) */
  onSelect: (command: SlashCommand) => void;
  /** Called when the palette should close (Escape) */
  onDismiss: () => void;
  /** Whether the palette is visible */
  visible: boolean;
}

export interface SlashCommandPaletteHandle {
  /** Handle keyboard events for navigation. Returns true if the event was consumed. */
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
  /** ID of the currently selected option element (for aria-activedescendant) */
  activeDescendantId: string | undefined;
}

/**
 * Autocomplete dropdown for slash commands.
 * Renders above the chat input with keyboard navigation and touch-friendly rows.
 *
 * Exposes a `handleKeyDown` method via ref so the parent textarea can delegate
 * navigation keys (ArrowUp/Down, Enter, Escape, Tab) to this component.
 */
export const SlashCommandPalette = forwardRef<SlashCommandPaletteHandle, SlashCommandPaletteProps>(
  function SlashCommandPalette({ commands, filter, onSelect, onDismiss, visible }, ref) {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const listRef = useRef<HTMLUListElement>(null);

    // Filter commands by the current input
    const filtered = commands.filter((cmd) =>
      cmd.name.toLowerCase().startsWith(filter.toLowerCase())
    );

    // Reset selection when filter or visibility changes
    useEffect(() => {
      setSelectedIndex(0);
    }, [filter, visible]);

    // Scroll selected item into view
    useEffect(() => {
      if (!listRef.current) return;
      const items = listRef.current.children;
      const selected = items[selectedIndex] as HTMLElement | undefined;
      if (selected && typeof selected.scrollIntoView === 'function') { selected.scrollIntoView({ block: 'nearest' }); }
    }, [selectedIndex]);

    // Expose keyboard handler to parent
    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent): boolean => {
        if (!visible || filtered.length === 0) return false;

        switch (e.key) {
          case 'ArrowUp': {
            e.preventDefault();
            setSelectedIndex((prev) => (prev <= 0 ? filtered.length - 1 : prev - 1));
            return true;
          }
          case 'ArrowDown': {
            e.preventDefault();
            setSelectedIndex((prev) => (prev >= filtered.length - 1 ? 0 : prev + 1));
            return true;
          }
          case 'Enter': {
            e.preventDefault();
            const cmd = filtered[selectedIndex];
            if (cmd) onSelect(cmd);
            return true;
          }
          case 'Escape': {
            e.preventDefault();
            onDismiss();
            return true;
          }
          case 'Tab': {
            // Tab also selects the current item (shell-like behavior)
            e.preventDefault();
            const cmd = filtered[selectedIndex];
            if (cmd) onSelect(cmd);
            return true;
          }
          default:
            return false;
        }
      },
      [visible, filtered, selectedIndex, onSelect, onDismiss]
    );

    const activeDescendantId = filtered[selectedIndex] ? `slash-cmd-${filtered[selectedIndex].name}` : undefined;

    useImperativeHandle(ref, () => ({ handleKeyDown, activeDescendantId }), [handleKeyDown, activeDescendantId]);

    if (!visible || filtered.length === 0) return null;

    // Calculate max height: each row ~44px (min touch target), capped at MAX_VISIBLE_ITEMS
    const maxHeight = MAX_VISIBLE_ITEMS * 44;

    return (
      <div className="mb-2">
        {/* Border uses semantic token; background uses --sam-color-bg-surface from the design system */}
        <div
          className="rounded-lg shadow-lg"
          style={{
            backgroundColor: 'var(--sam-color-bg-surface)',
            border: '1px solid var(--sam-color-border-default)',
          }}
        >
          <ul
            ref={listRef}
            id="slash-palette-listbox"
            role="listbox"
            aria-label="Slash commands"
            className="overflow-y-auto"
            style={{ maxHeight }}
          >
            {filtered.map((cmd, idx) => (
              <li
                key={`${cmd.source}-${cmd.name}`}
                id={`slash-cmd-${cmd.name}`}
                role="option"
                aria-selected={idx === selectedIndex}
                className="flex items-start gap-2 px-3 py-2 cursor-pointer select-none"
                style={{
                  minHeight: 44,
                  backgroundColor:
                    idx === selectedIndex
                      ? 'var(--sam-color-bg-surface-hover)'
                      : 'transparent',
                  color:
                    idx === selectedIndex
                      ? 'var(--sam-color-fg-primary)'
                      : 'var(--sam-color-fg-primary)',
                }}
                onClick={() => onSelect(cmd)}
                onMouseEnter={() => setSelectedIndex(idx)}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className="font-mono text-sm font-medium shrink-0"
                      style={{ color: 'var(--sam-color-fg-primary)' }}
                    >
                      /{cmd.name}
                    </span>
                    <span
                      className="shrink-0 text-xs px-1.5 py-0.5 rounded-full font-medium"
                      style={
                        cmd.source === 'agent'
                          ? {
                              /* Purple tint — uses Tokyo Night purple, subdued */
                              backgroundColor: 'rgba(187,154,247,0.15)',
                              color: 'var(--sam-color-tn-purple)',
                            }
                          : cmd.source === 'cached'
                            ? {
                                /* Amber tint — warning palette */
                                backgroundColor: 'rgba(245,158,11,0.15)',
                                color: 'var(--sam-color-warning)',
                              }
                            : {
                                /* Muted — fg-muted on inset bg */
                                backgroundColor: 'var(--sam-color-bg-inset)',
                                color: 'var(--sam-color-fg-muted)',
                              }
                      }
                    >
                      {cmd.source === 'agent' ? 'Agent' : cmd.source === 'cached' ? 'Cached' : 'SAM'}
                    </span>
                  </div>
                  <span
                    className="text-sm leading-snug"
                    style={{ color: 'var(--sam-color-fg-muted)' }}
                  >
                    {cmd.description}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }
);
