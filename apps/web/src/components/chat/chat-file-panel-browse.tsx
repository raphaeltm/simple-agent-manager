/**
 * The file panel's browse mode: breadcrumbs, the file search bar, search results and the
 * directory listing. Split out of `ChatFilePanel` to keep that file within the size limit
 * (rule 18); these hold no state of their own.
 */
import { Spinner } from '@simple-agent-manager/ui';
import { ChevronRight, FileText, Folder, Image, Search, X } from 'lucide-react';
import type { RefObject } from 'react';

import type { FileEntry } from '../../lib/api';
import { formatFileSize, isImageFile } from '../../lib/file-utils';
import type { fuzzyFilterFiles } from '../../lib/fuzzy-match';
import { HighlightedFilePath } from './chat-file-panel-rows';
import { buildBreadcrumbs } from './chat-file-panel-utils';

const ROW_CLASS =
  'w-full flex items-center gap-2.5 px-4 py-2 min-h-[44px] text-left bg-transparent border-none cursor-pointer hover:bg-[var(--sam-glass-v2-raised)]';

function PanelError({ message }: Readonly<{ message: string }>) {
  return (
    <div className="m-4 p-3 bg-danger-tint rounded-lg text-xs" style={{ color: 'var(--sam-color-tn-red)' }}>
      {message}
    </div>
  );
}

function FileIcon({ name }: Readonly<{ name: string }>) {
  return isImageFile(name) ? (
    <Image size={14} className="shrink-0" style={{ color: 'var(--sam-color-info, #3b82f6)' }} />
  ) : (
    <FileText size={14} className="shrink-0 text-fg-muted" />
  );
}

export function FileBreadcrumbs({
  path,
  onNavigate,
}: Readonly<{ path: string; onNavigate: (path: string) => void }>) {
  return (
    <div className="flex items-center gap-0.5 px-3 py-1.5 border-b border-[var(--sam-hairline)] overflow-x-auto shrink-0">
      {buildBreadcrumbs(path).map((crumb, idx, arr) => (
        <span key={crumb.path} className="flex items-center shrink-0">
          {idx > 0 && <ChevronRight size={12} className="text-fg-muted mx-0.5" />}
          <button
            type="button"
            onClick={() => onNavigate(crumb.path)}
            className={`bg-transparent border-none cursor-pointer px-1 py-0.5 rounded text-xs font-mono
              ${idx === arr.length - 1 ? 'text-fg-primary font-semibold' : 'text-fg-muted hover:text-fg-primary'}`}
          >
            {crumb.label}
          </button>
        </span>
      ))}
    </div>
  );
}

export function FileSearchBar({
  inputRef,
  query,
  onQueryChange,
  loading,
  onCancel,
  onSubmit,
}: Readonly<{
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQueryChange: (query: string) => void;
  loading: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}>) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--sam-hairline)] shrink-0">
      <Search size={14} className="text-fg-muted shrink-0" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search files by name..."
        aria-label="Search files"
        className="flex-1 min-w-0 bg-transparent border-none outline-none text-xs font-mono text-fg-primary placeholder:text-fg-muted"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter') onSubmit();
        }}
      />
      {loading && <Spinner size="sm" />}
      {query && (
        <button
          type="button"
          onClick={() => {
            onQueryChange('');
            inputRef.current?.focus();
          }}
          aria-label="Clear search"
          className="p-2 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary shrink-0"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

export function FileSearchResults({
  results,
  error,
  indexLoaded,
  query,
  onOpen,
}: Readonly<{
  results: ReturnType<typeof fuzzyFilterFiles>;
  error: string | null;
  indexLoaded: boolean;
  query: string;
  onOpen: (path: string) => void;
}>) {
  return (
    <>
      {error && <PanelError message={error} />}
      {!error && results.length === 0 && indexLoaded && (
        <div className="flex justify-center p-12 text-fg-muted text-sm">
          No files matching &ldquo;{query}&rdquo;
        </div>
      )}
      {results.length > 0 && (
        <div>
          {results.map((result) => (
            <button
              key={result.path}
              type="button"
              aria-label={`Open ${result.path}`}
              onClick={() => onOpen(result.path)}
              className={ROW_CLASS}
            >
              <FileIcon name={result.path} />
              <span className="flex flex-col min-w-0 flex-1">
                <HighlightedFilePath path={result.path} matches={result.matches} />
                <span className="text-[10px] text-fg-muted truncate">{result.path}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export function DirectoryListing({
  entries,
  loading,
  error,
  onOpenEntry,
}: Readonly<{
  entries: FileEntry[];
  loading: boolean;
  error: string | null;
  onOpenEntry: (entry: FileEntry) => void;
}>) {
  return (
    <>
      {loading && entries.length === 0 && (
        <div className="flex justify-center p-8">
          <Spinner size="md" />
        </div>
      )}
      {error && <PanelError message={error} />}
      {!error && entries.length === 0 && !loading && (
        <div className="flex justify-center p-12 text-fg-muted text-sm">This directory is empty</div>
      )}
      {entries.length > 0 && (
        <div style={{ opacity: loading ? 0.6 : 1, transition: 'opacity 0.15s' }}>
          {entries.map((entry) => (
            <button key={entry.name} type="button" onClick={() => onOpenEntry(entry)} className={ROW_CLASS}>
              {entry.type === 'dir' ? (
                <Folder size={14} className="shrink-0" style={{ color: 'var(--sam-color-accent-primary)' }} />
              ) : (
                <FileIcon name={entry.name} />
              )}
              <span className="text-xs font-mono text-fg-primary truncate flex-1 min-w-0">
                {entry.name}
                {entry.type === 'dir' ? '/' : ''}
              </span>
              {entry.type !== 'dir' && entry.size > 0 && (
                <span className="text-[11px] font-mono text-fg-muted shrink-0">
                  {formatFileSize(entry.size)}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
