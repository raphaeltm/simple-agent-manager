import { Filter, FolderPlus, Grid3X3, List, Upload } from 'lucide-react';

import type { SortOption, ViewMode } from './types';
import { FOCUS_RING } from './types';

interface LibraryToolbarProps {
  isMobile: boolean;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  sortBy: SortOption;
  onSortChange: (sort: SortOption) => void;
  showFilters: boolean;
  onToggleFilters: () => void;
  activeFilterCount: number;
  onNewFolder: () => void;
  onToggleUpload: () => void;
}

/** Header action row for the library — view toggle, sort, filter, new folder, upload. */
export function LibraryToolbar({
  isMobile,
  viewMode,
  onViewModeChange,
  sortBy,
  onSortChange,
  showFilters,
  onToggleFilters,
  activeFilterCount,
  onNewFolder,
  onToggleUpload,
}: LibraryToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 min-w-0">
      <h1 className="text-xl font-semibold text-fg-primary m-0 shrink-0">Library</h1>

      <div className="flex-1 min-w-[20px]" />

      {/* View toggle */}
      {!isMobile && (
        <div className="flex rounded-lg border border-border-default overflow-hidden shrink-0">
          <button
            onClick={() => onViewModeChange('list')}
            aria-label="List view"
            aria-pressed={viewMode === 'list'}
            className={`p-2 border-none cursor-pointer ${FOCUS_RING} ${
              viewMode === 'list'
                ? 'bg-accent/10 text-accent'
                : 'bg-[color-mix(in_srgb,var(--sam-glass-nested-bg)_80%,transparent)] text-fg-muted hover:text-fg-primary'
            }`}
          >
            <List size={16} />
          </button>
          <button
            onClick={() => onViewModeChange('grid')}
            aria-label="Grid view"
            aria-pressed={viewMode === 'grid'}
            className={`p-2 border-none cursor-pointer ${FOCUS_RING} ${
              viewMode === 'grid'
                ? 'bg-accent/10 text-accent'
                : 'bg-[color-mix(in_srgb,var(--sam-glass-nested-bg)_80%,transparent)] text-fg-muted hover:text-fg-primary'
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
          onChange={(e) => onSortChange(e.target.value as SortOption)}
          aria-label="Sort by"
          className="px-2.5 py-2 text-sm rounded-lg border border-[var(--sam-form-border)] bg-inset text-fg-primary focus:outline-none focus:border-accent cursor-pointer shrink-0"
        >
          <option value="createdAt">Newest</option>
          <option value="filename">Name</option>
          <option value="sizeBytes">Size</option>
        </select>
      )}

      {/* Filter toggle */}
      <button
        onClick={onToggleFilters}
        aria-label="Toggle filters"
        aria-pressed={showFilters}
        className={`relative p-2 rounded-lg border cursor-pointer ${FOCUS_RING} ${
          showFilters || activeFilterCount > 0
            ? 'border-accent bg-accent/10 text-accent'
            : 'border-[var(--sam-form-border)] bg-[color-mix(in_srgb,var(--sam-glass-nested-bg)_80%,transparent)] text-fg-muted hover:text-fg-primary'
        }`}
      >
        <Filter size={16} />
        {activeFilterCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-accent text-fg-on-accent text-[10px] font-semibold px-1">
            {activeFilterCount}
          </span>
        )}
      </button>

      {/* New folder button */}
      <button
        onClick={onNewFolder}
        aria-label="New folder"
        className={`p-2 rounded-lg border border-[var(--sam-form-border)] cursor-pointer bg-[color-mix(in_srgb,var(--sam-glass-nested-bg)_80%,transparent)] text-fg-muted hover:text-fg-primary ${FOCUS_RING} shrink-0`}
      >
        <FolderPlus size={16} />
      </button>

      {/* Upload button */}
      <button
        onClick={onToggleUpload}
        aria-label="Upload files"
        className={`flex items-center gap-2 px-3 py-2 rounded-lg border-none cursor-pointer bg-accent text-fg-on-accent font-medium text-sm hover:bg-accent/90 ${FOCUS_RING} shrink-0`}
      >
        <Upload size={16} />
        {!isMobile && <span>Upload</span>}
      </button>
    </div>
  );
}
