import type { DirectoryEntry, FileUploadSource, ListFilesRequest } from '@simple-agent-manager/shared';
import { LIBRARY_DEFAULTS } from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import { Filter, Folder, FolderOpen, FolderPlus, Grid3X3, List, Search, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CreateDirectoryDialog } from '../components/library/CreateDirectoryDialog';
import { DirectoryBreadcrumb } from '../components/library/DirectoryBreadcrumb';
import { FileGridCard } from '../components/library/FileGridCard';
import { FileListItem } from '../components/library/FileListItem';
import { FilePreviewModal } from '../components/library/FilePreviewModal';
import { TagEditor } from '../components/library/TagEditor';
import type { FileWithTags, SortOption, UploadItem, ViewMode } from '../components/library/types';
import { FOCUS_RING } from '../components/library/types';
import { UploadProgressChips } from '../components/library/UploadProgressChips';
import { UploadZone } from '../components/library/UploadZone';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useIsMobile } from '../hooks/useIsMobile';
import {
  downloadLibraryFile,
  getLibraryFilePreviewUrl,
  listLibraryDirectories,
  listLibraryFiles,
  uploadLibraryFile,
} from '../lib/api';
import { formatFileSize } from '../lib/file-utils';
import { useProjectContext } from './ProjectContext';

let uploadIdCounter = 0;

export function ProjectLibrary() {
  const { projectId } = useProjectContext();
  const isMobile = useIsMobile();

  // Data state
  const [files, setFiles] = useState<FileWithTags[]>([]);
  const [directories, setDirectories] = useState<DirectoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Directory navigation
  const [currentDirectory, setCurrentDirectory] = useState('/');

  // View state
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [sortBy, setSortBy] = useState<SortOption>('createdAt');
  const [showFilters, setShowFilters] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [showCreateDir, setShowCreateDir] = useState(false);

  // Filter state — searchInput is the raw value; debouncedSearch drives API calls
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [sourceFilter, setSourceFilter] = useState<'all' | FileUploadSource>('all');

  // Track whether search is pending (input changed but debounced value hasn't caught up)
  const isSearchPending = searchInput !== debouncedSearch;

  // Uploads
  const [uploads, setUploads] = useState<UploadItem[]>([]);

  // Tag editor
  const [editingTagsFile, setEditingTagsFile] = useState<FileWithTags | null>(null);

  // Preview
  const [previewFile, setPreviewFile] = useState<FileWithTags | null>(null);

  // Active filter count for badge
  const activeFilterCount =
    (searchInput ? 1 : 0) + activeTags.length + (sourceFilter !== 'all' ? 1 : 0);

  // Searching spans all directories
  const isSearching = !!debouncedSearch;

  // All unique tags from loaded files
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const f of files) {
      for (const t of f.tags) tagSet.add(t.tag);
    }
    return Array.from(tagSet).sort();
  }, [files]);

  // ---------------------------------------------------------------------------
  // Data loading — only uses debouncedSearch, not raw searchInput
  // ---------------------------------------------------------------------------

  // Track whether initial load has completed so subsequent filter changes use background refresh
  const hasLoadedOnce = useRef(false);

  const loadFiles = useCallback(
    async (opts?: { background?: boolean }) => {
      const isBackground = opts?.background || hasLoadedOnce.current;
      if (isBackground) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
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

        const [filesResult, dirsResult] = await Promise.all([
          listLibraryFiles(projectId, filters),
          // Only load directories when not searching
          isSearching
            ? Promise.resolve({ directories: [] })
            : listLibraryDirectories(projectId, currentDirectory),
        ]);

        setFiles(filesResult.files);
        setTotal(filesResult.total);
        setDirectories(dirsResult.directories);
        hasLoadedOnce.current = true;
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
    loadFiles();
  }, [loadFiles]);

  // ---------------------------------------------------------------------------
  // Directory navigation
  // ---------------------------------------------------------------------------

  const navigateToDirectory = useCallback((dir: string) => {
    setCurrentDirectory(dir);
  }, []);

  const handleCreateDirectory = useCallback(
    (dirPath: string) => {
      setShowCreateDir(false);
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

        const existing = files.find((f) => f.filename === file.name && f.directory === currentDirectory);
        if (existing) {
          continue;
        }

        const id = `upload-${++uploadIdCounter}`;
        const item: UploadItem = { id, file, progress: 0, status: 'uploading' };

        setUploads((prev) => [...prev, item]);

        uploadLibraryFile(projectId, file, {
          directory: currentDirectory,
          onProgress: (loaded, uploadTotal) => {
            const pct = Math.round((loaded / uploadTotal) * 100);
            setUploads((prev) =>
              prev.map((u) => (u.id === id ? { ...u, progress: pct } : u)),
            );
          },
        })
          .then(() => {
            setUploads((prev) =>
              prev.map((u) =>
                u.id === id ? { ...u, status: 'done' as const, progress: 100 } : u,
              ),
            );
            loadFiles({ background: true });
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
    [projectId, files, loadFiles, currentDirectory],
  );

  const dismissUpload = useCallback((id: string) => {
    setUploads((prev) => prev.filter((u) => u.id !== id));
  }, []);

  // ---------------------------------------------------------------------------
  // Tag filter toggle
  // ---------------------------------------------------------------------------

  const handleTagClick = useCallback((tag: string) => {
    setActiveTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  }, []);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col gap-4 overflow-x-hidden w-full max-w-full min-w-0 ${isMobile ? 'px-4 py-3' : 'px-6 py-4'}`}
    >
      {/* Header bar */}
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        <h1 className="text-xl font-semibold text-fg-primary m-0 shrink-0">Library</h1>

        <div className="flex-1 min-w-[20px]" />

        {/* View toggle */}
        {!isMobile && (
          <div className="flex rounded-lg border border-border-default overflow-hidden shrink-0">
            <button
              onClick={() => setViewMode('list')}
              aria-label="List view"
              aria-pressed={viewMode === 'list'}
              className={`p-2 border-none cursor-pointer ${FOCUS_RING} ${
                viewMode === 'list'
                  ? 'bg-accent/10 text-accent'
                  : 'bg-surface text-fg-muted hover:text-fg-primary'
              }`}
            >
              <List size={16} />
            </button>
            <button
              onClick={() => setViewMode('grid')}
              aria-label="Grid view"
              aria-pressed={viewMode === 'grid'}
              className={`p-2 border-none cursor-pointer ${FOCUS_RING} ${
                viewMode === 'grid'
                  ? 'bg-accent/10 text-accent'
                  : 'bg-surface text-fg-muted hover:text-fg-primary'
              }`}
            >
              <Grid3X3 size={16} />
            </button>
          </div>
        )}

        {/* Sort dropdown — hidden on mobile, available in filter panel */}
        {!isMobile && (
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortOption)}
            aria-label="Sort by"
            className="px-2.5 py-2 text-sm rounded-lg border border-border-default bg-surface-inset text-fg-primary focus:outline-none focus:border-accent cursor-pointer shrink-0"
          >
            <option value="createdAt">Newest</option>
            <option value="filename">Name</option>
            <option value="sizeBytes">Size</option>
          </select>
        )}

        {/* Filter toggle */}
        <button
          onClick={() => setShowFilters(!showFilters)}
          aria-label="Toggle filters"
          aria-pressed={showFilters}
          className={`relative p-2 rounded-lg border cursor-pointer ${FOCUS_RING} ${
            showFilters || activeFilterCount > 0
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border-default bg-surface text-fg-muted hover:text-fg-primary'
          }`}
        >
          <Filter size={16} />
          {activeFilterCount > 0 && (
            <span className="absolute -top-1.5 -right-1.5 flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-accent text-white text-[10px] font-semibold px-1">
              {activeFilterCount}
            </span>
          )}
        </button>

        {/* New folder button */}
        <button
          onClick={() => setShowCreateDir(true)}
          aria-label="New folder"
          className={`p-2 rounded-lg border border-border-default cursor-pointer bg-surface text-fg-muted hover:text-fg-primary ${FOCUS_RING} shrink-0`}
        >
          <FolderPlus size={16} />
        </button>

        {/* Upload button */}
        <button
          onClick={() => setShowUpload(!showUpload)}
          aria-label="Upload files"
          className={`flex items-center gap-2 px-3 py-2 rounded-lg border-none cursor-pointer bg-accent text-white font-medium text-sm hover:bg-accent/90 ${FOCUS_RING} shrink-0`}
        >
          <Upload size={16} />
          {!isMobile && <span>Upload</span>}
        </button>
      </div>

      {/* Directory breadcrumb */}
      <DirectoryBreadcrumb directory={currentDirectory} onNavigate={navigateToDirectory} />

      {/* Filter bar (collapsible) */}
      {showFilters && (
        <div className="flex flex-col gap-3 p-3 rounded-lg border border-border-default bg-surface-inset">
          {/* Sort (mobile only — hidden on desktop where it's in the header) */}
          {isMobile && (
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
              aria-label="Sort by"
              className="w-full px-2.5 py-2 text-sm rounded-lg border border-border-default bg-surface text-fg-primary focus:outline-none focus:border-accent cursor-pointer"
            >
              <option value="createdAt">Newest</option>
              <option value="filename">Name</option>
              <option value="sizeBytes">Size</option>
            </select>
          )}

          {/* Search input with inline spinner */}
          <div className="relative">
            <Search
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none"
            />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search files across all directories..."
              className="w-full pl-9 pr-9 py-2 text-sm rounded-lg border border-border-default bg-surface text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-accent"
            />
            {/* Inline spinner shown while debounce is pending or API is in-flight */}
            {(isSearchPending || refreshing) && searchInput && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                <Spinner size="sm" />
              </div>
            )}
          </div>

          {/* Tag chips */}
          {allTags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {allTags.map((tag) => {
                const isActive = activeTags.includes(tag);
                return (
                  <button
                    key={tag}
                    onClick={() => handleTagClick(tag)}
                    className={`px-2.5 py-1 rounded-full text-xs border-none cursor-pointer transition-colors ${FOCUS_RING} ${
                      isActive
                        ? 'bg-accent text-white'
                        : 'bg-surface text-fg-muted hover:bg-accent/10 hover:text-accent'
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
                className={`px-3 py-1.5 rounded-lg text-xs border-none cursor-pointer transition-colors ${FOCUS_RING} ${
                  sourceFilter === src
                    ? 'bg-accent text-white'
                    : 'bg-surface text-fg-muted hover:bg-accent/10 hover:text-accent'
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
          onUpdated={() => loadFiles({ background: true })}
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

      {/* Directories — always shown as a compact card grid */}
      {directories.length > 0 && (
        <div
          className={`grid gap-3 ${
            isMobile
              ? 'grid-cols-2'
              : 'grid-cols-[repeat(auto-fill,minmax(120px,140px))]'
          }`}
        >
          {directories.map((dir) => (
            <button
              key={dir.path}
              onClick={() => navigateToDirectory(dir.path)}
              aria-label={`Folder: ${dir.name}, ${dir.fileCount} file${dir.fileCount !== 1 ? 's' : ''}`}
              className={`flex flex-col items-center justify-center gap-2 p-4 rounded-lg border border-border-default bg-surface hover:bg-surface-inset cursor-pointer aspect-square ${FOCUS_RING}`}
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
      {files.length === 0 && directories.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <FolderOpen size={40} className="text-fg-muted mb-3 opacity-30" />
          <p className="text-sm text-fg-muted m-0 max-w-xs">
            {activeFilterCount > 0
              ? 'No files match your filters.'
              : currentDirectory !== '/'
                ? 'This folder is empty.'
                : 'No files yet. Upload files to share with your agents.'}
          </p>
          {activeFilterCount === 0 && (
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
          {files.map((file) => (
            <FileListItem
              key={file.id}
              file={file}
              projectId={projectId}
              onDeleted={() => loadFiles({ background: true })}
              onEditTags={setEditingTagsFile}
              onTagClick={handleTagClick}
              onPreview={setPreviewFile}
            />
          ))}
        </div>
      ) : (
        <div
          className={`grid gap-3 ${isMobile ? 'grid-cols-2' : 'grid-cols-[repeat(auto-fill,minmax(200px,1fr))]'}`}
        >
          {files.map((file) => (
            <FileGridCard
              key={file.id}
              file={file}
              projectId={projectId}
              onDeleted={() => loadFiles({ background: true })}
              onEditTags={setEditingTagsFile}
              onTagClick={handleTagClick}
              onPreview={setPreviewFile}
            />
          ))}
        </div>
      )}

      {/* File count + refreshing indicator */}
      {files.length > 0 && (
        <div className="flex items-center justify-center gap-2">
          {refreshing && <Spinner size="sm" />}
          <p className="text-xs text-fg-muted text-center m-0">
            Showing {files.length} of {total} file{total !== 1 ? 's' : ''}
            {currentDirectory !== '/' && !isSearching && (
              <span> in {currentDirectory}</span>
            )}
          </p>
        </div>
      )}

      {/* Preview modal */}
      {previewFile && (
        <FilePreviewModal
          file={previewFile}
          previewUrl={getLibraryFilePreviewUrl(projectId, previewFile.id)}
          onClose={() => setPreviewFile(null)}
          onDownload={() => downloadLibraryFile(projectId, previewFile.id)}
        />
      )}
    </div>
  );
}
