import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from 'react';
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

    useImperativeHandle(ref, () => ({ handleKeyDown }), [handleKeyDown]);

    if (!visible || filtered.length === 0) return null;

    // Calculate max height: each row ~44px (min touch target), capped at MAX_VISIBLE_ITEMS
    const maxHeight = MAX_VISIBLE_ITEMS * 44;

    return (
      <div
        className="absolute bottom-full left-0 right-0 mb-1 z-10"
        role="listbox"
        aria-label="Slash commands"
      >
        <div
          className="bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden"
          style={{ maxHeight }}
        >
          <ul
            ref={listRef}
            className="overflow-y-auto"
            style={{ maxHeight }}
          >
            {filtered.map((cmd, idx) => (
              <li
                key={`${cmd.source}-${cmd.name}`}
                role="option"
                aria-selected={idx === selectedIndex}
                className={`flex items-center justify-between px-3 cursor-pointer select-none ${
                  idx === selectedIndex
                    ? 'bg-blue-50 text-blue-900'
                    : 'text-gray-700 hover:bg-gray-50'
                }`}
                style={{ minHeight: 44 }}
                onClick={() => onSelect(cmd)}
                onMouseEnter={() => setSelectedIndex(idx)}
              >
                <div className="flex items-center space-x-2 min-w-0 flex-1">
                  <span className="font-mono text-sm font-medium shrink-0">/{cmd.name}</span>
                  <span className="text-sm text-gray-500 truncate">{cmd.description}</span>
                </div>
                <span
                  className={`ml-2 shrink-0 text-xs px-1.5 py-0.5 rounded-full font-medium ${
                    cmd.source === 'agent'
                      ? 'bg-purple-100 text-purple-700'
                      : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {cmd.source === 'agent' ? 'Agent' : 'SAM'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }
);
