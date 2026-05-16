import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

/** An agent profile entry for the mention autocomplete */
export interface MentionProfile {
  id: string;
  name: string;
  description: string | null;
}

/** Maximum number of visible items before scrolling */
const MAX_VISIBLE_ITEMS = 8;

export interface MentionPaletteProps {
  /** Available profiles to filter and display */
  profiles: MentionProfile[];
  /** Text after the "@" trigger to filter by */
  filter: string;
  /** Called when a profile is selected (click, Enter, or Tab) */
  onSelect: (profile: MentionProfile) => void;
  /** Called when the palette should close (Escape) */
  onDismiss: () => void;
  /** Whether the palette is visible */
  visible: boolean;
}

export interface MentionPaletteHandle {
  /** Handle keyboard events for navigation. Returns true if consumed. */
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
  /** ID of the currently selected option element (for aria-activedescendant) */
  activeDescendantId: string | undefined;
}

/**
 * Autocomplete dropdown for @mentions of agent profiles.
 * Renders above the chat input with keyboard navigation and touch-friendly rows.
 *
 * Exposes a `handleKeyDown` method via ref so the parent textarea can delegate
 * navigation keys (ArrowUp/Down, Enter, Escape, Tab) to this component.
 */
export const MentionPalette = forwardRef<MentionPaletteHandle, MentionPaletteProps>(
  function MentionPalette({ profiles, filter, onSelect, onDismiss, visible }, ref) {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const listRef = useRef<HTMLUListElement>(null);

    const filtered = profiles.filter((p) =>
      p.name.toLowerCase().startsWith(filter.toLowerCase())
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
      if (selected && typeof selected.scrollIntoView === 'function') {
        selected.scrollIntoView({ block: 'nearest' });
      }
    }, [selectedIndex]);

    const selectCurrentProfile = useCallback(() => {
      const profile = filtered[selectedIndex];
      if (profile) onSelect(profile);
    }, [filtered, selectedIndex, onSelect]);

    const moveSelection = useCallback((direction: 1 | -1) => {
      setSelectedIndex((prev) => {
        const lastIndex = filtered.length - 1;
        if (direction < 0) return prev <= 0 ? lastIndex : prev - 1;
        return prev >= lastIndex ? 0 : prev + 1;
      });
    }, [filtered.length]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent): boolean => {
        if (!visible || filtered.length === 0) return false;

        const handlers: Record<string, () => void> = {
          ArrowUp: () => moveSelection(-1),
          ArrowDown: () => moveSelection(1),
          Enter: selectCurrentProfile,
          Tab: selectCurrentProfile,
          Escape: onDismiss,
        };
        const handler = handlers[e.key];
        if (!handler) return false;

        e.preventDefault();
        handler();
        return true;
      },
      [visible, filtered.length, moveSelection, selectCurrentProfile, onDismiss]
    );

    const handleOptionKeyDown = useCallback(
      (e: React.KeyboardEvent, profile: MentionProfile) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        onSelect(profile);
      },
      [onSelect]
    );

    const activeDescendantId = filtered[selectedIndex]
      ? `mention-profile-${filtered[selectedIndex].id}`
      : undefined;

    useImperativeHandle(ref, () => ({ handleKeyDown, activeDescendantId }), [
      handleKeyDown,
      activeDescendantId,
    ]);

    if (!visible || filtered.length === 0) return null;

    const maxHeight = MAX_VISIBLE_ITEMS * 44;

    return (
      <div className="mb-2">
        <div
          className="rounded-lg shadow-lg"
          style={{
            backgroundColor: 'var(--sam-color-bg-surface)',
            border: '1px solid var(--sam-color-border-default)',
          }}
        >
          <ul
            ref={listRef}
            id="mention-palette-listbox"
            role="listbox"
            aria-label="Agent profiles"
            className="overflow-y-auto"
            style={{ maxHeight }}
          >
            {filtered.map((profile, idx) => (
              <li
                key={profile.id}
                id={`mention-profile-${profile.id}`}
                role="option"
                aria-selected={idx === selectedIndex}
                className="flex items-start gap-2 px-3 py-2 cursor-pointer select-none"
                style={{
                  minHeight: 44,
                  backgroundColor:
                    idx === selectedIndex
                      ? 'var(--sam-color-bg-surface-hover)'
                      : 'transparent',
                }}
                onClick={() => onSelect(profile)}
                onKeyDown={(e) => handleOptionKeyDown(e, profile)}
                onMouseEnter={() => setSelectedIndex(idx)}
                tabIndex={-1}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className="font-mono text-sm font-medium shrink-0"
                      style={{ color: 'var(--sam-color-fg-primary)' }}
                    >
                      @{profile.name}
                    </span>
                  </div>
                  {profile.description && (
                    <span
                      className="text-sm leading-snug"
                      style={{ color: 'var(--sam-color-fg-muted)' }}
                    >
                      {profile.description}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }
);
