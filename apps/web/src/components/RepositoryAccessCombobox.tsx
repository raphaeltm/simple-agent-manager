import type { AvailableRepository } from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { listAvailableRepositories } from '../lib/api';

/**
 * Searchable combobox for selecting an additional repository to grant to a
 * project. Lazy-loads the live user∩app installation intersection on first
 * open (excluding the primary repo and already-added repos, handled server
 * side). Falls back to free-text owner/repo entry so a repository that isn't
 * surfaced in the intersection list can still be typed manually — the add
 * endpoint re-validates access regardless.
 */
export function RepositoryAccessCombobox({
  projectId,
  disabled,
  adding,
  onAdd,
}: {
  projectId: string;
  disabled?: boolean;
  adding?: boolean;
  onAdd: (repository: string) => void | Promise<void>;
}) {
  const listId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<AvailableRepository[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const loadOptions = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const response = await listAvailableRepositories(projectId);
      setOptions(response.repositories);
    } catch {
      setError(true);
    } finally {
      // Mark the attempt as made (success or failure) so the open effect does
      // not auto-retry. The Retry button re-invokes this directly.
      setLoaded(true);
      setLoading(false);
    }
  }, [projectId]);

  // Load the intersection the first time the menu is opened.
  useEffect(() => {
    if (open && !loaded && !loading) {
      void loadOptions();
    }
  }, [open, loaded, loading, loadOptions]);

  // Close on outside click.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onDocClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? options.filter((o) => o.repository.toLowerCase().includes(normalizedQuery))
    : options;

  const trimmed = query.trim();
  // A manual entry is offerable when the text looks like owner/repo and isn't
  // already an exact match in the filtered list.
  const looksLikeRepo = /^[^/\s]+\/[^/\s]+$/.test(trimmed);
  const exactMatch = filtered.some((o) => o.repository.toLowerCase() === trimmed.toLowerCase());
  const canAddManual = looksLikeRepo && !exactMatch;

  const commitAdd = (repository: string) => {
    const value = repository.trim();
    if (!value) {
      return;
    }
    void onAdd(value);
    setQuery('');
    setOpen(false);
    setActiveIndex(-1);
    // Optimistically drop the chosen option from the list so it isn't offered
    // again before the parent reloads.
    setOptions((prev) => prev.filter((o) => o.repository.toLowerCase() !== value.toLowerCase()));
  };

  const totalItems = filtered.length + (canAddManual ? 1 : 0);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActiveIndex((i) => (totalItems === 0 ? -1 : (i + 1) % totalItems));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => (totalItems === 0 ? -1 : (i - 1 + totalItems) % totalItems));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const active =
        activeIndex >= 0 && activeIndex < filtered.length ? filtered[activeIndex] : undefined;
      if (active) {
        commitAdd(active.repository);
      } else if (canAddManual) {
        commitAdd(trimmed);
      } else if (filtered.length === 1 && filtered[0]) {
        commitAdd(filtered[0].repository);
      }
    } else if (event.key === 'Escape') {
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  return (
    <div className="flex-1 min-w-0 relative" ref={containerRef}>
      <label className="block text-xs text-fg-muted mb-0.5" htmlFor={`${listId}-input`}>
        Repository (owner/repo)
      </label>
      <input
        id={`${listId}-input`}
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label="Additional repository"
        placeholder="Search or type owner/repo"
        autoComplete="off"
        value={query}
        disabled={disabled}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.currentTarget.value);
          setOpen(true);
          setActiveIndex(-1);
        }}
        onKeyDown={handleKeyDown}
        className="block w-full py-1.5 px-2.5 min-h-9 border border-border-default rounded-sm bg-inset text-fg-primary text-[0.8125rem] font-[inherit] box-border"
      />

      {open && (
        <div
          id={listId}
          role="listbox"
          className="absolute z-20 left-0 right-0 mt-1 max-h-60 overflow-y-auto border border-border-default rounded-sm bg-surface shadow-lg"
        >
          {loading && (
            <div className="flex items-center gap-2 py-2 px-2.5 text-xs text-fg-muted">
              <Spinner size="sm" />
              <span>Loading repositories&hellip;</span>
            </div>
          )}

          {!loading && error && (
            <div className="py-2 px-2.5 text-xs text-danger">
              Failed to load repositories.{' '}
              <button
                type="button"
                onClick={() => void loadOptions()}
                className="underline bg-transparent border-none cursor-pointer text-danger p-0"
              >
                Retry
              </button>
            </div>
          )}

          {!loading && !error && (
            <>
              {filtered.map((option, idx) => (
                <button
                  type="button"
                  key={option.repository}
                  role="option"
                  aria-selected={activeIndex === idx}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => commitAdd(option.repository)}
                  disabled={adding}
                  className={`flex items-center gap-2 w-full text-left py-1.5 px-2.5 text-[0.8125rem] bg-transparent border-none cursor-pointer ${
                    activeIndex === idx ? 'bg-inset' : ''
                  }`}
                >
                  <code className="font-semibold text-fg-primary text-[0.8125rem] overflow-hidden text-ellipsis whitespace-nowrap min-w-0">
                    {option.repository}
                  </code>
                  <span className="flex-1" />
                  <span className="text-[0.6875rem] text-fg-muted bg-inset px-1.5 py-px rounded-sm shrink-0">
                    {option.private ? 'private' : 'public'}
                  </span>
                </button>
              ))}

              {canAddManual && (
                <button
                  type="button"
                  role="option"
                  aria-selected={activeIndex === filtered.length}
                  onMouseEnter={() => setActiveIndex(filtered.length)}
                  onClick={() => commitAdd(trimmed)}
                  disabled={adding}
                  className={`flex items-center gap-2 w-full text-left py-1.5 px-2.5 text-[0.8125rem] bg-transparent border-none cursor-pointer ${
                    activeIndex === filtered.length ? 'bg-inset' : ''
                  }`}
                >
                  <span className="text-fg-muted text-xs">Add</span>
                  <code className="font-semibold text-fg-primary text-[0.8125rem]">{trimmed}</code>
                  <span className="text-fg-muted text-[0.6875rem]">(manual)</span>
                </button>
              )}

              {filtered.length === 0 && !canAddManual && (
                <div className="py-2 px-2.5 text-xs text-fg-muted">
                  {options.length === 0
                    ? 'No additional repositories available through this installation.'
                    : 'No matching repositories. Type a full owner/repo to add manually.'}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
