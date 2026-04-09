import type {
  FileUploadSource,
  ListFilesRequest,
  ProjectFile,
  ProjectFileTag,
} from '@simple-agent-manager/shared';
import { LIBRARY_DEFAULTS } from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import {
  Download,
  File as FileIcon,
  FileCode,
  FileImage,
  FileText,
  Filter,
  FolderOpen,
  Grid3X3,
  List,
  MoreVertical,
  Plus,
  Search,
  Tag,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useIsMobile } from '../hooks/useIsMobile';
import {
  deleteLibraryFile,
  downloadLibraryFile,
  listLibraryFiles,
  updateFileTags,
  uploadLibraryFile,
} from '../lib/api';
import { formatFileSize } from '../lib/file-utils';
import { useProjectContext } from './ProjectContext';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ViewMode = 'list' | 'grid';
type SortOption = 'createdAt' | 'filename' | 'sizeBytes';

interface FileWithTags extends ProjectFile {
  tags: ProjectFileTag[];
}

interface UploadItem {
  id: string;
  file: File;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return <FileImage size={18} className="text-accent" aria-hidden="true" />;
  if (mimeType.startsWith('text/')) return <FileText size={18} className="text-fg-muted" aria-hidden="true" />;
  if (mimeType.includes('javascript') || mimeType.includes('json') || mimeType.includes('xml'))
    return <FileCode size={18} className="text-fg-muted" aria-hidden="true" />;
  return <FileIcon size={18} className="text-fg-muted" aria-hidden="true" />;
}

let uploadIdCounter = 0;

const FOCUS_RING = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

// ---------------------------------------------------------------------------
// UploadZone
// ---------------------------------------------------------------------------

interface UploadZoneProps {
  onFiles: (files: File[]) => void;
}

function UploadZone({ onFiles }: UploadZoneProps) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) onFiles(files);
    },
    [onFiles],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      if (files.length > 0) onFiles(files);
      // Reset so same file can be re-selected
      e.target.value = '';
    },
    [onFiles],
  );

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
      role="button"
      tabIndex={0}
      aria-label="Drop files here or click to browse"
      className={`flex flex-col items-center justify-center gap-2 p-6 rounded-lg border-2 border-dashed cursor-pointer transition-colors ${
        dragOver
          ? 'border-accent bg-accent/10'
          : 'border-border-default hover:border-accent/50 bg-surface-inset'
      } ${FOCUS_RING}`}
    >
      <Upload size={24} className={dragOver ? 'text-accent' : 'text-fg-muted'} aria-hidden="true" />
      <p className="text-sm text-fg-muted m-0">Drop files here or click to browse</p>
      <p className="text-xs text-fg-muted m-0">
        Max {formatFileSize(LIBRARY_DEFAULTS.UPLOAD_MAX_BYTES)} per file
      </p>
      <input
        ref={inputRef}
        type="file"
        multiple
        onChange={handleChange}
        className="hidden"
        aria-hidden="true"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// UploadProgressChips
// ---------------------------------------------------------------------------

interface UploadProgressChipsProps {
  uploads: UploadItem[];
  onDismiss: (id: string) => void;
}

function UploadProgressChips({ uploads, onDismiss }: UploadProgressChipsProps) {
  if (uploads.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {uploads.map((u) => (
        <div
          key={u.id}
          className="relative flex items-center gap-2 px-3 py-1.5 rounded-full border border-border-default bg-surface text-xs overflow-hidden"
        >
          {/* Progress bar background */}
          {u.status === 'uploading' && (
            <div
              className="absolute inset-0 bg-accent/10 transition-[width] duration-200"
              style={{ width: `${u.progress}%` }}
            />
          )}
          <span className="relative truncate max-w-[120px]">{u.file.name}</span>
          {u.status === 'uploading' && (
            <span className="relative text-fg-muted">{u.progress}%</span>
          )}
          {u.status === 'done' && (
            <span className="relative text-success">Done</span>
          )}
          {u.status === 'error' && (
            <span className="relative text-danger" title={u.error}>Failed</span>
          )}
          {u.status !== 'uploading' && (
            <button
              onClick={() => onDismiss(u.id)}
              className={`relative p-0.5 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary ${FOCUS_RING} rounded`}
              aria-label={`Dismiss ${u.file.name}`}
            >
              <X size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FileActionsMenu
// ---------------------------------------------------------------------------

interface FileActionsMenuProps {
  file: FileWithTags;
  projectId: string;
  onDeleted: () => void;
  onEditTags: (file: FileWithTags) => void;
}

function FileActionsMenu({ file, projectId, onDeleted, onEditTags }: FileActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const handleDownload = () => {
    setOpen(false);
    downloadLibraryFile(projectId, file.id);
  };

  const handleDelete = async () => {
    setOpen(false);
    if (!window.confirm(`Delete "${file.filename}"? This cannot be undone.`)) return;
    try {
      await deleteLibraryFile(projectId, file.id);
      onDeleted();
    } catch (err) {
      console.error('Failed to delete file:', err);
    }
  };

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`p-1.5 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary rounded ${FOCUS_RING}`}
        aria-label={`Actions for ${file.filename}`}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <MoreVertical size={16} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 min-w-[160px] rounded-lg border border-border-default bg-surface shadow-lg py-1">
          <button
            onClick={handleDownload}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-fg-primary bg-transparent border-none cursor-pointer hover:bg-surface-hover text-left"
          >
            <Download size={14} /> Download
          </button>
          <button
            onClick={() => { setOpen(false); onEditTags(file); }}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-fg-primary bg-transparent border-none cursor-pointer hover:bg-surface-hover text-left"
          >
            <Tag size={14} /> Edit Tags
          </button>
          <button
            onClick={handleDelete}
            className="flex items-center gap-2 w-full px-3 py-2 text-sm text-danger bg-transparent border-none cursor-pointer hover:bg-surface-hover text-left"
          >
            <Trash2 size={14} /> Delete
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TagEditor (inline)
// ---------------------------------------------------------------------------

interface TagEditorProps {
  file: FileWithTags;
  projectId: string;
  onUpdated: () => void;
  onClose: () => void;
}

function TagEditor({ file, projectId, onUpdated, onClose }: TagEditorProps) {
  const [newTag, setNewTag] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleAddTag = async () => {
    const tag = newTag.trim().toLowerCase();
    if (!tag) return;
    if (file.tags.some((t) => t.tag === tag)) {
      setNewTag('');
      return;
    }
    setSaving(true);
    try {
      await updateFileTags(projectId, file.id, { add: [tag] });
      setNewTag('');
      onUpdated();
    } catch (err) {
      console.error('Failed to add tag:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveTag = async (tag: string) => {
    setSaving(true);
    try {
      await updateFileTags(projectId, file.id, { remove: [tag] });
      onUpdated();
    } catch (err) {
      console.error('Failed to remove tag:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 p-3 rounded-lg border border-border-default bg-surface">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-fg-muted uppercase tracking-wider">Tags for {file.filename}</span>
        <button
          onClick={onClose}
          className={`p-1 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary rounded ${FOCUS_RING}`}
          aria-label="Close tag editor"
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {file.tags.map((t) => (
          <span
            key={t.tag}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-accent/10 text-accent"
          >
            {t.tag}
            <button
              onClick={() => handleRemoveTag(t.tag)}
              disabled={saving}
              className="p-0 bg-transparent border-none cursor-pointer text-accent/70 hover:text-accent disabled:opacity-50"
              aria-label={`Remove tag ${t.tag}`}
            >
              <X size={10} />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAddTag(); }}
          placeholder="Add tag..."
          maxLength={LIBRARY_DEFAULTS.MAX_TAG_LENGTH}
          className="flex-1 px-2.5 py-1.5 text-xs rounded border border-border-default bg-surface-inset text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-accent"
        />
        <button
          onClick={handleAddTag}
          disabled={saving || !newTag.trim()}
          className={`px-2.5 py-1.5 text-xs rounded bg-accent text-white border-none cursor-pointer disabled:opacity-50 ${FOCUS_RING}`}
        >
          {saving ? <Spinner size="sm" /> : <Plus size={12} />}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FileListItem
// ---------------------------------------------------------------------------

interface FileListItemProps {
  file: FileWithTags;
  projectId: string;
  onDeleted: () => void;
  onEditTags: (file: FileWithTags) => void;
  onTagClick: (tag: string) => void;
}

function FileListItem({ file, projectId, onDeleted, onEditTags, onTagClick }: FileListItemProps) {
  const maxVisibleTags = 3;
  const visibleTags = file.tags.slice(0, maxVisibleTags);
  const overflowCount = file.tags.length - maxVisibleTags;

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 min-h-[56px] rounded-lg border border-border-default bg-surface hover:border-accent/40 transition-colors">
      {/* Icon */}
      <div className="shrink-0">{getFileIcon(file.mimeType)}</div>

      {/* File info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-fg-primary truncate">{file.filename}</span>
          {file.uploadSource === 'agent' && (
            <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-accent/10 text-accent shrink-0">
              agent
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-fg-muted mt-0.5">
          <span>{formatFileSize(file.sizeBytes)}</span>
          <span aria-hidden="true">&middot;</span>
          <span>{timeAgo(file.createdAt)}</span>
        </div>
      </div>

      {/* Tags */}
      <div className="hidden sm:flex items-center gap-1 shrink-0">
        {visibleTags.map((t) => (
          <button
            key={t.tag}
            onClick={() => onTagClick(t.tag)}
            className={`px-2 py-0.5 rounded-full text-[11px] bg-surface-inset text-fg-muted hover:bg-accent/10 hover:text-accent border-none cursor-pointer ${FOCUS_RING}`}
          >
            {t.tag}
          </button>
        ))}
        {overflowCount > 0 && (
          <span className="px-1.5 py-0.5 rounded-full text-[11px] text-fg-muted">
            +{overflowCount}
          </span>
        )}
      </div>

      {/* Actions */}
      <FileActionsMenu
        file={file}
        projectId={projectId}
        onDeleted={onDeleted}
        onEditTags={onEditTags}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// FileGridCard
// ---------------------------------------------------------------------------

interface FileGridCardProps {
  file: FileWithTags;
  projectId: string;
  onDeleted: () => void;
  onEditTags: (file: FileWithTags) => void;
  onTagClick: (tag: string) => void;
}

function FileGridCard({ file, projectId, onDeleted, onEditTags, onTagClick }: FileGridCardProps) {
  return (
    <div className="flex flex-col rounded-lg border border-border-default bg-surface hover:border-accent/40 transition-colors overflow-hidden">
      {/* Thumbnail area */}
      <div className="flex items-center justify-center h-24 bg-surface-inset">
        {getFileIcon(file.mimeType)}
      </div>

      {/* Info */}
      <div className="flex flex-col gap-1.5 p-3">
        <div className="flex items-center justify-between gap-1">
          <span className="text-sm font-medium text-fg-primary truncate">{file.filename}</span>
          <FileActionsMenu
            file={file}
            projectId={projectId}
            onDeleted={onDeleted}
            onEditTags={onEditTags}
          />
        </div>
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <span>{formatFileSize(file.sizeBytes)}</span>
          <span aria-hidden="true">&middot;</span>
          <span>{timeAgo(file.createdAt)}</span>
          {file.uploadSource === 'agent' && (
            <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-accent/10 text-accent">
              agent
            </span>
          )}
        </div>
        {file.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-0.5">
            {file.tags.slice(0, 3).map((t) => (
              <button
                key={t.tag}
                onClick={() => onTagClick(t.tag)}
                className={`px-1.5 py-0.5 rounded-full text-[10px] bg-surface-inset text-fg-muted hover:bg-accent/10 hover:text-accent border-none cursor-pointer ${FOCUS_RING}`}
              >
                {t.tag}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main: ProjectLibrary
// ---------------------------------------------------------------------------

export function ProjectLibrary() {
  const { projectId } = useProjectContext();
  const isMobile = useIsMobile();

  // Data state
  const [files, setFiles] = useState<FileWithTags[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // View state
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [sortBy, setSortBy] = useState<SortOption>('createdAt');
  const [showFilters, setShowFilters] = useState(false);
  const [showUpload, setShowUpload] = useState(false);

  // Filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [sourceFilter, setSourceFilter] = useState<'all' | FileUploadSource>('all');

  // Uploads
  const [uploads, setUploads] = useState<UploadItem[]>([]);

  // Tag editor
  const [editingTagsFile, setEditingTagsFile] = useState<FileWithTags | null>(null);

  // Active filter count for badge
  const activeFilterCount = (searchQuery ? 1 : 0) + activeTags.length + (sourceFilter !== 'all' ? 1 : 0);

  // All unique tags from loaded files
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const f of files) {
      for (const t of f.tags) tagSet.add(t.tag);
    }
    return Array.from(tagSet).sort();
  }, [files]);

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  const loadFiles = useCallback(
    async (opts?: { background?: boolean }) => {
      if (opts?.background) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      try {
        const filters: ListFilesRequest = {
          search: searchQuery || undefined,
          tags: activeTags.length > 0 ? activeTags : undefined,
          uploadSource: sourceFilter !== 'all' ? sourceFilter : undefined,
          sortBy,
          sortOrder: sortBy === 'filename' ? 'asc' : 'desc',
          limit: LIBRARY_DEFAULTS.LIST_DEFAULT_PAGE_SIZE,
        };
        const result = await listLibraryFiles(projectId, filters);
        setFiles(result.files);
        setTotal(result.total);
      } catch (err) {
        console.error('Failed to load library files:', err);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [projectId, searchQuery, activeTags, sourceFilter, sortBy],
  );

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  // ---------------------------------------------------------------------------
  // Upload handling
  // ---------------------------------------------------------------------------

  const handleUploadFiles = useCallback(
    (newFiles: File[]) => {
      for (const file of newFiles) {
        if (file.size > LIBRARY_DEFAULTS.UPLOAD_MAX_BYTES) {
          window.alert(`"${file.name}" exceeds the ${formatFileSize(LIBRARY_DEFAULTS.UPLOAD_MAX_BYTES)} limit.`);
          continue;
        }

        // Check for filename collision
        const existing = files.find((f) => f.filename === file.name);
        if (existing) {
          if (!window.confirm(`"${file.name}" already exists. Upload as a new file?`)) continue;
        }

        const id = `upload-${++uploadIdCounter}`;
        const item: UploadItem = { id, file, progress: 0, status: 'uploading' };

        setUploads((prev) => [...prev, item]);

        uploadLibraryFile(projectId, file, {
          onProgress: (loaded, total) => {
            const pct = Math.round((loaded / total) * 100);
            setUploads((prev) =>
              prev.map((u) => (u.id === id ? { ...u, progress: pct } : u)),
            );
          },
        })
          .then(() => {
            setUploads((prev) =>
              prev.map((u) => (u.id === id ? { ...u, status: 'done' as const, progress: 100 } : u)),
            );
            // Refresh file list in background
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
    [projectId, files, loadFiles],
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
    <div className={`flex flex-col gap-4 overflow-x-hidden w-full max-w-full min-w-0 ${isMobile ? 'px-4 py-3' : 'px-6 py-4'}`}>
      {/* Header bar */}
      <div className="flex items-center gap-2 min-w-0">
        <h1 className="text-xl font-semibold text-fg-primary m-0 shrink-0">Library</h1>
        {refreshing && <Spinner size="sm" />}

        <div className="flex-1" />

        {/* View toggle */}
        <div className="flex rounded-lg border border-border-default overflow-hidden shrink-0">
          <button
            onClick={() => setViewMode('list')}
            aria-label="List view"
            aria-pressed={viewMode === 'list'}
            className={`p-2 border-none cursor-pointer ${FOCUS_RING} ${
              viewMode === 'list' ? 'bg-accent/10 text-accent' : 'bg-surface text-fg-muted hover:text-fg-primary'
            }`}
          >
            <List size={16} />
          </button>
          <button
            onClick={() => setViewMode('grid')}
            aria-label="Grid view"
            aria-pressed={viewMode === 'grid'}
            className={`p-2 border-none cursor-pointer ${FOCUS_RING} ${
              viewMode === 'grid' ? 'bg-accent/10 text-accent' : 'bg-surface text-fg-muted hover:text-fg-primary'
            }`}
          >
            <Grid3X3 size={16} />
          </button>
        </div>

        {/* Sort dropdown */}
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

      {/* Filter bar (collapsible) */}
      {showFilters && (
        <div className="flex flex-col gap-3 p-3 rounded-lg border border-border-default bg-surface-inset">
          {/* Search input */}
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search files..."
              className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-border-default bg-surface text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-accent"
            />
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

      {/* File display */}
      {files.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <FolderOpen size={40} className="text-fg-muted mb-3 opacity-30" />
          <p className="text-sm text-fg-muted m-0 max-w-xs">
            {activeFilterCount > 0
              ? 'No files match your filters.'
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
            />
          ))}
        </div>
      ) : (
        <div className={`grid gap-3 ${isMobile ? 'grid-cols-2' : 'grid-cols-[repeat(auto-fill,minmax(200px,1fr))]'}`}>
          {files.map((file) => (
            <FileGridCard
              key={file.id}
              file={file}
              projectId={projectId}
              onDeleted={() => loadFiles({ background: true })}
              onEditTags={setEditingTagsFile}
              onTagClick={handleTagClick}
            />
          ))}
        </div>
      )}

      {/* File count */}
      {files.length > 0 && (
        <p className="text-xs text-fg-muted text-center m-0">
          Showing {files.length} of {total} file{total !== 1 ? 's' : ''}
        </p>
      )}
    </div>
  );
}
