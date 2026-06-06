import type { DirectoryEntry, FileUploadSource, ListFilesRequest } from '@simple-agent-manager/shared';
import { LIBRARY_DEFAULTS } from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import { Folder, FolderOpen, Search, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

import { CreateDirectoryDialog } from '../components/library/CreateDirectoryDialog';
import { DirectoryBreadcrumb } from '../components/library/DirectoryBreadcrumb';
import { FileGridCard } from '../components/library/FileGridCard';
import { FileListItem } from '../components/library/FileListItem';
import { FilePreviewModal } from '../components/library/FilePreviewModal';
import { LibraryToolbar } from '../components/library/LibraryToolbar';
import { TagEditor } from '../components/library/TagEditor';
import type { FileWithTags, SortOption, UploadItem, ViewMode } from '../components/library/types';
import { FOCUS_RING } from '../components/library/types';
import { UploadProgressChips } from '../components/library/UploadProgressChips';
import { UploadZone } from '../components/library/UploadZone';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useIsMobile } from '../hooks/useIsMobile';
import { useLibraryIndex } from '../hooks/useLibraryIndex';
import {
  downloadLibraryFile,
  getLibraryFilePreviewUrl,
  listLibraryDirectories,
  listLibraryFiles,
  uploadLibraryFile,
} from '../lib/api';
import { formatFileSize } from '../lib/file-utils';
import {
  getCachedDirectories,
  getCachedFiles,
  setCachedDirectories,
  setCachedFiles,
} from '../lib/library-cache';
import { searchIndex } from '../lib/library-search';
import { useProjectContext } from './ProjectContext';

let uploadIdCounter = 0;

/** Sort a file list for the unfiltered (non-search) view. Matches server defaults. */
function sortFiles(files: FileWithTags[], sortBy: SortOption): FileWithTags[] {
  const copy = [...files];
  switch (sortBy) {
    case 'filename':
      return copy.sort((a, b) => a.filename.localeCompare(b.filename));
    case 'sizeBytes':
      return copy.sort((a, b) => b.sizeBytes - a.sizeBytes);
    case 'createdAt':
    default:
      return copy.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

/** Apply the advanced tag/source filters client-side (sub-cap path). */
function applyAdvancedFilters(
  files: FileWithTags[],
  activeTags: string[],
  sourceFilter: 'all' | FileUploadSource,
): FileWithTags[] {
  if (activeTags.length === 0 && sourceFilter === 'all') return files;
  return files.filter((f) => {
    if (sourceFilter !== 'all' && f.uploadSource !== sourceFilter) return false;
    if (activeTags.length > 0) {
      const fileTags = new Set(f.tags.map((t) => t.tag));
      if (!activeTags.every((t) => fileTags.has(t))) return false;
    }
    return true;
  });
}

export function ProjectLibrary() {
  const { projectId } = useProjectContext();
  const isMobile = useIsMobile();
  const [searchParams, setSearchParams] = useSearchParams();

  // URL-driven directory navigation — `?dir=/path`
  const currentDirectory = searchParams.get('dir') || '/';
  // URL-driven file preview — `?preview=fileId`
  const previewFileId = searchParams.get('preview');

  // ---------------------------------------------------------------------------
  // Client-side index (sub-cap projects). At/over cap, `status === 'overCap'`
  // and we fall back to the legacy server-search path below.
  // ---------------------------------------------------------------------------
  const {
    files: sweptFiles,
    index,
    status: indexStatus,
    isSweeping,
    sweepError,
    invalidate,
  } = useLibraryIndex(projectId);
  const isOverCap = indexStatus === 'overCap';

  // Directory cache for instant render of folder cards
  const initialCachedDirs = getCachedDirectories(projectId, '/') ?? [];
  const [directories, setDirectories] = useState<DirectoryEntry[]>(initialCachedDirs);
  const [dirRefreshToken, setDirRefreshToken] = useState(0);

  // ---------------------------------------------------------------------------
  // Legacy server-search state (used ONLY when status === 'overCap')
  // ---------------------------------------------------------------------------
  const initialCachedFiles = getCachedFiles(projectId, '/', 'createdAt');
  const [serverFiles, setServerFiles] = useState<FileWithTags[]>(
    initialCachedFiles ? initialCachedFiles.files : [],
  );
  const [loading, setLoading] = useState(!initialCachedFiles);
  const [refreshing, setRefreshing] = useState(false);
  const hasLoadedOnce = useRef(!!initialCachedFiles);

  // View state
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [sortBy, setSortBy] = useState<SortOption>('createdAt');
  const [showFilters, setShowFilters] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showCreateDir, setShowCreateDir] = useState(false);

  // Search — searchInput is LOCAL state; filtering against the index is instant.
  // debouncedSearch drives ONLY (a) URL write-only reflection and (b) the
  // over-cap server-search fallback. It is never read back into the input.
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebouncedValue(searchInput, LIBRARY_DEFAULTS.CLIENT_SEARCH_DEBOUNCE_MS);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [sourceFilter, setSourceFilter] = useState<'all' | FileUploadSource>('all');
  const isSearchPending = searchInput !== debouncedSearch;

  const query = searchInput.trim();
  const isSearching = query.length > 0;

  // Debounced screen-reader announcement. The visible count updates instantly on
  // every keystroke (sub-cap filtering is synchronous), but announcing on every
  // keystroke floods assistive tech. We mirror the visible text into a separate
  // sr-only live region that only updates once typing settles (debouncedSearch).
  const [announcement, setAnnouncement] = useState('');

  // Uploads
  const [uploads, setUploads] = useState<UploadItem[]>([]);

  // Tag editor
  const [editingTagsFile, setEditingTagsFile] = useState<FileWithTags | null>(null);

  // The authoritative file set for the active mode (used for preview + tag list)
  const allFiles = isOverCap ? serverFiles : sweptFiles;

  // Preview — derived from URL param + loaded files
  const previewFile = useMemo(
    () => (previewFileId ? allFiles.find((f) => f.id === previewFileId) ?? null : null),
    [previewFileId, allFiles],
  );

  // Active filter count for badge — EXCLUDES searchInput (search is always visible)
  const activeFilterCount = activeTags.length + (sourceFilter !== 'all' ? 1 : 0);

  // All unique tags from the active file set
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const f of allFiles) {
      for (const t of f.tags) tagSet.add(t.tag);
    }
    return Array.from(tagSet).sort();
  }, [allFiles]);

  // ---------------------------------------------------------------------------
  // Display lists — instant client filtering (sub-cap) or server result (over-cap)
  // ---------------------------------------------------------------------------

  const displayFiles = useMemo(() => {
    if (isOverCap) {
      // Server already applied search + tag + source filters
      return serverFiles;
    }
    let result: FileWithTags[];
    if (isSearching) {
      const matches = searchIndex(index, query);
      result = matches ? matches.map((m) => m.file) : [];
    } else {
      result = sortFiles(
        sweptFiles.filter((f) => f.directory === currentDirectory),
        sortBy,
      );
    }
    return applyAdvancedFilters(result, activeTags, sourceFilter);
  }, [
    isOverCap,
    serverFiles,
    isSearching,
    index,
    query,
    sweptFiles,
    currentDirectory,
    sortBy,
    activeTags,
    sourceFilter,
  ]);

  // Directory cards are hidden during active search (the matcher already spans
  // directory paths, surfacing files across all folders).
  const displayDirectories = isSearching ? [] : directories;

  // Refs hold the latest counts so the debounced announcement effect can read
  // settled values without re-firing on every intermediate keystroke.
  const displayFilesCountRef = useRef(displayFiles.length);
  displayFilesCountRef.current = displayFiles.length;
  const displayDirsCountRef = useRef(displayDirectories.length);
  displayDirsCountRef.current = displayDirectories.length;

  // anyContent toggles only at the empty boundary (and on first load), never on
  // every keystroke — so it drives the initial announcement without flooding.
  const anyContent = displayFiles.length > 0 || displayDirectories.length > 0;
  useEffect(() => {
    const dq = debouncedSearch.trim();
    const searching = dq.length > 0;
    const fileCount = displayFilesCountRef.current;
    const dirCount = displayDirsCountRef.current;
    if (fileCount > 0 || dirCount > 0) {
      let text = searching
        ? `${fileCount} result${fileCount !== 1 ? 's' : ''} for “${dq}”`
        : `${fileCount} file${fileCount !== 1 ? 's' : ''}`;
      if (dirCount > 0) text += `, ${dirCount} folder${dirCount !== 1 ? 's' : ''}`;
      if (currentDirectory !== '/' && !searching) text += ` in ${currentDirectory}`;
      setAnnouncement(text);
    } else if (searching) {
      setAnnouncement(`No files match “${dq}”`);
    } else {
      setAnnouncement('');
    }
  }, [debouncedSearch, currentDirectory, anyContent]);

  // ---------------------------------------------------------------------------
  // Directory fetch — runs for both modes, on project/dir change or mutation.
  // Kept server-side so freshly created (empty) directories still appear.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    listLibraryDirectories(projectId, currentDirectory)
      .then((res) => {
        if (cancelled) return;
        setDirectories(res.directories);
        setCachedDirectories(projectId, currentDirectory, res.directories);
      })
      .catch((err) => {
        if (!cancelled) console.error('Failed to load directories:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, currentDirectory, dirRefreshToken]);

  // ---------------------------------------------------------------------------
  // Legacy server-search load — gated behind the over-cap fallback
  // ---------------------------------------------------------------------------
  const loadServerFiles = useCallback(
    async (opts?: { background?: boolean }) => {
      const isBackground = opts?.background || hasLoadedOnce.current;
      if (isBackground) setRefreshing(true);
      else setLoading(true);
      try {
        const filters: ListFilesRequest = {
          search: debouncedSearch || undefined,
          tags: activeTags.length > 0 ? activeTags : undefined,
          uploadSource: sourceFilter !== 'all' ? sourceFilter : undefined,
          directory: currentDirectory,
          recursive: isSearching ? true : undefined,
          sortBy,
          sortOrder: sortBy === 'filename' ? 'asc' : 'desc',
          limit: LIBRARY_DEFAULTS.LIST_DEFAULT_PAGE_SIZE,
        };
        const filesResult = await listLibraryFiles(projectId, filters);
        setServerFiles(filesResult.files);
        hasLoadedOnce.current = true;
        if (!debouncedSearch && activeTags.length === 0 && sourceFilter === 'all') {
          setCachedFiles(projectId, currentDirectory, sortBy, filesResult);
        }
      } catch (err) {
        console.error('Failed to load library files:', err);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [projectId, debouncedSearch, activeTags, sourceFilter, sortBy, currentDirectory, isSearching],
  );

  useEffect(() => {
    if (isOverCap) void loadServerFiles();
  }, [isOverCap, loadServerFiles]);

  // ---------------------------------------------------------------------------
  // Mutation refresh — re-sweep the client index (sub-cap), re-fetch
  // directories, and refresh the server list (over-cap). dir fileCounts are a
  // server aggregate; move returns no tags — so a trailing re-sweep is required.
  // ---------------------------------------------------------------------------
  const refreshAfterMutation = useCallback(() => {
    invalidate();
    setDirRefreshToken((t) => t + 1);
    if (isOverCap) void loadServerFiles({ background: true });
  }, [invalidate, isOverCap, loadServerFiles]);

  // ---------------------------------------------------------------------------
  // Write-only URL reflection of the search query (debounced). Never read back.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (debouncedSearch) next.set('q', debouncedSearch);
        else next.delete('q');
        return next;
      },
      { replace: true },
    );
  }, [debouncedSearch, setSearchParams]);

  // ---------------------------------------------------------------------------
  // Directory navigation
  // ---------------------------------------------------------------------------
  const navigateToDirectory = useCallback(
    (dir: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (dir === '/') next.delete('dir');
        else next.set('dir', dir);
        return next;
      });
    },
    [setSearchParams],
  );

  // Move focus to the breadcrumb after a directory change (skip initial mount)
  const breadcrumbRef = useRef<HTMLDivElement>(null);
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    breadcrumbRef.current?.focus();
  }, [currentDirectory]);

  const handleCreateDirectory = useCallback(
    (dirPath: string) => {
      setShowCreateDir(false);
      setDirRefreshToken((t) => t + 1);
      navigateToDirectory(dirPath);
    },
    [navigateToDirectory],
  );

  // ---------------------------------------------------------------------------
  // Upload handling
  // ---------------------------------------------------------------------------
  const handleUploadFiles = useCallback(
    (newFiles: File[]) => {
      for (const file of newFiles) {
        if (file.size > LIBRARY_DEFAULTS.UPLOAD_MAX_BYTES) {
          const id = `upload-${++uploadIdCounter}`;
          setUploads((prev) => [
            ...prev,
            {
              id,
              file,
              progress: 0,
              status: 'error' as const,
              error: `Exceeds ${formatFileSize(LIBRARY_DEFAULTS.UPLOAD_MAX_BYTES)} limit`,
            },
          ]);
          continue;
        }

        const existing = allFiles.find(
          (f) => f.filename === file.name && f.directory === currentDirectory,
        );
        if (existing) continue;

        const id = `upload-${++uploadIdCounter}`;
        const item: UploadItem = { id, file, progress: 0, status: 'uploading' };
        setUploads((prev) => [...prev, item]);

        uploadLibraryFile(projectId, file, {
          directory: currentDirectory,
          onProgress: (loaded, uploadTotal) => {
            const pct = Math.round((loaded / uploadTotal) * 100);
            setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, progress: pct } : u)));
          },
        })
          .then(() => {
            setUploads((prev) =>
              prev.map((u) => (u.id === id ? { ...u, status: 'done' as const, progress: 100 } : u)),
            );
            refreshAfterMutation();
          })
          .catch((err: Error) => {
            setUploads((prev) =>
              prev.map((u) =>
                u.id === id ? { ...u, status: 'error' as const, error: err.message } : u,
              ),
            );
          });
      }
    },
    [projectId, allFiles, refreshAfterMutation, currentDirectory],
  );

  const dismissUpload = useCallback((id: string) => {
    setUploads((prev) => prev.filter((u) => u.id !== id));
  }, []);

  // ---------------------------------------------------------------------------
  // Preview + tag filter
  // ---------------------------------------------------------------------------
  const openPreview = useCallback(
    (file: FileWithTags) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('preview', file.id);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const closePreview = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('preview');
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  const handleTagClick = useCallback((tag: string) => {
    setActiveTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }, []);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  // Full-page spinner ONLY on a true first load with nothing to show. Background
  // re-sweeps and refreshes keep existing rows mounted (no flicker).
  const isInitialLoading = isOverCap
    ? loading
    : indexStatus === 'loading' && sweptFiles.length === 0;
  const isRefreshing = isOverCap ? refreshing : isSweeping;

  if (isInitialLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  const hasContent = displayFiles.length > 0 || displayDirectories.length > 0;

  return (
    <div
      className={`flex flex-col gap-4 overflow-x-hidden w-full max-w-full min-w-0 ${isMobile ? 'px-4 py-3' : 'px-6 py-4'}`}
    >
      {/* Header bar */}
      <LibraryToolbar
        isMobile={isMobile}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        sortBy={sortBy}
        onSortChange={setSortBy}
        showFilters={showFilters}
        onToggleFilters={() => setShowFilters(!showFilters)}
        activeFilterCount={activeFilterCount}
        onNewFolder={() => setShowCreateDir(true)}
        onToggleUpload={() => setShowUpload(!showUpload)}
      />

      {/* Always-visible search row — full width, between header and breadcrumb.
          Sticky on mobile so it stays reachable while scrolling long lists.
          z-10 lifts the row above scrolling file/folder cards (which create no
          stacking context of their own) so it stays opaque over them; the bg
          fill prevents content bleeding through during scroll. */}
      <div className={isMobile ? 'sticky top-0 z-10 -mx-4 px-4 py-2 bg-canvas' : ''}>
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none"
            aria-hidden="true"
          />
          <input
            id="library-search"
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label="Search files and folders"
            placeholder="Search files and folders..."
            maxLength={LIBRARY_DEFAULTS.MAX_SEARCH_LENGTH}
            className="w-full pl-9 pr-9 py-2 text-sm rounded-lg border border-[rgba(34,197,94,0.10)] bg-[rgba(8,15,12,0.5)] text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-accent"
          />
          {/* Inline spinner only in the over-cap server path (sub-cap is instant) */}
          {isOverCap && (isSearchPending || refreshing) && searchInput && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              <Spinner size="sm" />
            </div>
          )}
        </div>
      </div>

      {/* Directory breadcrumb (focus target after navigation) */}
      <div ref={breadcrumbRef} tabIndex={-1} className="outline-none">
        <DirectoryBreadcrumb directory={currentDirectory} onNavigate={navigateToDirectory} />
      </div>

      {/* Non-blocking sweep error banner */}
      {!isOverCap && sweepError && (
        <div
          role="status"
          className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.08)] text-xs text-warning-fg"
        >
          <span>Some files may be missing — refresh to retry.</span>
          <button
            onClick={() => invalidate()}
            className={`px-2 py-1 rounded-md border border-[rgba(245,158,11,0.4)] bg-transparent text-warning-fg cursor-pointer ${FOCUS_RING}`}
          >
            Retry
          </button>
        </div>
      )}

      {/* Filter bar (collapsible) — advanced tag/source filters only */}
      {showFilters && (
        <div className="flex flex-col gap-3 p-3 rounded-lg border border-[rgba(34,197,94,0.10)] bg-[rgba(8,15,12,0.5)]-inset">
          {/* Sort (mobile only — hidden on desktop where it's in the header) */}
          {isMobile && (
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
              aria-label="Sort by"
              className="w-full px-2.5 py-2 text-sm rounded-lg border border-[rgba(34,197,94,0.10)] bg-[rgba(8,15,12,0.5)] text-fg-primary focus:outline-none focus:border-accent cursor-pointer"
            >
              <option value="createdAt">Newest</option>
              <option value="filename">Name</option>
              <option value="sizeBytes">Size</option>
            </select>
          )}

          {/* Tag chips */}
          {allTags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {allTags.map((tag) => {
                const isActive = activeTags.includes(tag);
                return (
                  <button
                    key={tag}
                    onClick={() => handleTagClick(tag)}
                    aria-pressed={isActive}
                    aria-label={`Filter by tag: ${tag}`}
                    className={`px-2.5 py-1 rounded-full text-xs border-none cursor-pointer transition-colors ${FOCUS_RING} ${
                      isActive
                        ? 'bg-accent text-white'
                        : 'bg-[rgba(8,15,12,0.4)] text-fg-muted hover:bg-accent/10 hover:text-accent'
                    }`}
                  >
                    {tag}
                  </button>
                );
              })}
            </div>
          )}

          {/* Source filter */}
          <div className="flex items-center gap-1">
            {(['all', 'user', 'agent'] as const).map((src) => (
              <button
                key={src}
                onClick={() => setSourceFilter(src)}
                aria-pressed={sourceFilter === src}
                aria-label={
                  src === 'all'
                    ? 'Show files from all sources'
                    : src === 'user'
                      ? 'Show only user-uploaded files'
                      : 'Show only agent-uploaded files'
                }
                className={`px-3 py-1.5 rounded-lg text-xs border-none cursor-pointer transition-colors ${FOCUS_RING} ${
                  sourceFilter === src
                    ? 'bg-accent text-white'
                    : 'bg-[rgba(8,15,12,0.4)] text-fg-muted hover:bg-accent/10 hover:text-accent'
                }`}
              >
                {src === 'all' ? 'All' : src === 'user' ? 'User' : 'Agent'}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Upload zone (collapsible) */}
      {showUpload && <UploadZone onFiles={handleUploadFiles} />}

      {/* Upload progress chips */}
      <UploadProgressChips uploads={uploads} onDismiss={dismissUpload} />

      {/* Tag editor */}
      {editingTagsFile && (
        <TagEditor
          file={editingTagsFile}
          projectId={projectId}
          onUpdated={refreshAfterMutation}
          onClose={() => setEditingTagsFile(null)}
        />
      )}

      {/* Create directory dialog */}
      {showCreateDir && (
        <CreateDirectoryDialog
          currentDirectory={currentDirectory}
          onCreated={handleCreateDirectory}
          onClose={() => setShowCreateDir(false)}
        />
      )}

      {/* Status bar — visible count updates instantly; the debounced sr-only live
          region below announces the settled count without flooding screen readers. */}
      <div className="flex items-center gap-2">
        {isRefreshing && <Spinner size="sm" />}
        <p className="text-xs text-fg-muted m-0">
          {hasContent ? (
            <>
              {isSearching
                ? `${displayFiles.length} result${displayFiles.length !== 1 ? 's' : ''} for “${query}”`
                : `${displayFiles.length} file${displayFiles.length !== 1 ? 's' : ''}`}
              {displayDirectories.length > 0 &&
                `, ${displayDirectories.length} folder${displayDirectories.length !== 1 ? 's' : ''}`}
              {currentDirectory !== '/' && !isSearching && <span> in {currentDirectory}</span>}
              {isRefreshing && <span className="ml-1">— updating…</span>}
            </>
          ) : isSearching ? (
            `No files match “${query}”`
          ) : (
            ''
          )}
        </p>
        {/* Debounced live region — announces only the settled result count. */}
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {announcement}
        </span>
      </div>

      {/* Directories — compact card grid (hidden during search) */}
      {displayDirectories.length > 0 && (
        <div
          className={`grid gap-3 ${
            isMobile ? 'grid-cols-2' : 'grid-cols-[repeat(auto-fill,minmax(120px,140px))]'
          }`}
        >
          {displayDirectories.map((dir) => (
            <button
              key={dir.path}
              onClick={() => navigateToDirectory(dir.path)}
              aria-label={`Folder: ${dir.name}, ${dir.fileCount} file${dir.fileCount !== 1 ? 's' : ''}`}
              className={`flex flex-col items-center justify-center gap-2 p-4 rounded-lg border border-[rgba(34,197,94,0.10)] bg-[rgba(8,15,12,0.5)] hover:bg-surface-inset cursor-pointer aspect-square ${FOCUS_RING}`}
            >
              <Folder size={32} className="text-accent shrink-0" aria-hidden="true" />
              <span className="text-sm font-medium text-fg-primary truncate max-w-full text-center">
                {dir.name}
              </span>
              <span className="text-xs text-fg-muted">
                {dir.fileCount} file{dir.fileCount !== 1 ? 's' : ''}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Files content */}
      {displayFiles.length === 0 && displayDirectories.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <FolderOpen size={40} className="text-fg-muted mb-3 opacity-30" />
          <p className="text-sm text-fg-muted m-0 max-w-xs">
            {isSearching
              ? `No files match “${query}”.`
              : activeFilterCount > 0
                ? 'No files match your filters.'
                : currentDirectory !== '/'
                  ? 'This folder is empty.'
                  : 'No files yet. Upload files to share with your agents.'}
          </p>
          {!isSearching && activeFilterCount === 0 && (
            <button
              onClick={() => setShowUpload(true)}
              className={`mt-4 flex items-center gap-2 px-4 py-2.5 rounded-lg bg-accent text-white text-sm font-medium border-none cursor-pointer hover:bg-accent/90 ${FOCUS_RING}`}
            >
              <Upload size={16} /> Upload Files
            </button>
          )}
        </div>
      ) : viewMode === 'list' ? (
        <div className="flex flex-col gap-1.5">
          {displayFiles.map((file) => (
            <FileListItem
              key={file.id}
              file={file}
              projectId={projectId}
              onDeleted={refreshAfterMutation}
              onEditTags={setEditingTagsFile}
              onTagClick={handleTagClick}
              onPreview={openPreview}
            />
          ))}
        </div>
      ) : (
        <div
          className={`grid gap-3 ${isMobile ? 'grid-cols-2' : 'grid-cols-[repeat(auto-fill,minmax(200px,1fr))]'}`}
        >
          {displayFiles.map((file) => (
            <FileGridCard
              key={file.id}
              file={file}
              projectId={projectId}
              onDeleted={refreshAfterMutation}
              onEditTags={setEditingTagsFile}
              onTagClick={handleTagClick}
              onPreview={openPreview}
            />
          ))}
        </div>
      )}

      {/* Preview modal */}
      {previewFile && (
        <FilePreviewModal
          file={previewFile}
          previewUrl={getLibraryFilePreviewUrl(projectId, previewFile.id)}
          onClose={closePreview}
          onDownload={() => downloadLibraryFile(projectId, previewFile.id)}
        />
      )}
    </div>
  );
}
