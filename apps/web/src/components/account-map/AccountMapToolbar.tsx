import type { FC } from 'react';
import { Search, RotateCcw, X, Eye, EyeOff } from 'lucide-react';
import type { EntityType } from './hooks/useMapFilters';

interface FilterChip {
  type: EntityType;
  label: string;
  shortLabel: string;
  color: string;
}

const FILTER_CHIPS: FilterChip[] = [
  { type: 'project', label: 'Projects', shortLabel: 'Proj', color: 'bg-accent' },
  { type: 'node', label: 'Nodes', shortLabel: 'Node', color: 'bg-success' },
  { type: 'workspace', label: 'Workspaces', shortLabel: 'WS', color: 'bg-[#00ccff]' },
  { type: 'session', label: 'Sessions', shortLabel: 'Chat', color: 'bg-[#aa88ff]' },
  { type: 'task', label: 'Tasks', shortLabel: 'Task', color: 'bg-warning' },
];

interface AccountMapToolbarProps {
  searchQuery: string;
  onSearchChange: (query: string) => void;
  activeFilters: Set<EntityType>;
  onToggleFilter: (type: EntityType) => void;
  onResetFilters: () => void;
  onReorganize: () => void;
  hasActiveFilters: boolean;
  matchCount: number;
  totalCount: number;
  stats: Record<string, number>;
  isMobile: boolean;
  activeOnly: boolean;
  onToggleActiveOnly: () => void;
}

export const AccountMapToolbar: FC<AccountMapToolbarProps> = ({
  searchQuery,
  onSearchChange,
  activeFilters,
  onToggleFilter,
  onResetFilters,
  onReorganize,
  hasActiveFilters,
  matchCount,
  totalCount,
  stats,
  isMobile,
  activeOnly,
  onToggleActiveOnly,
}) => {
  return (
    <div className="flex flex-col gap-2 p-3 bg-surface border-b border-border-default">
      {/* Search row */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none"
          />
          <input
            type="text"
            placeholder="Search entities..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full pl-8 pr-8 py-1.5 text-sm bg-inset border border-border-default rounded-md text-fg-primary placeholder:text-fg-muted focus:outline-none focus:ring-1 focus:ring-focus-ring"
          />
          {searchQuery && (
            <button
              onClick={() => onSearchChange('')}
              className="absolute right-1 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg-primary bg-transparent border-none cursor-pointer p-1.5 -m-0.5"
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {searchQuery && (
          <span className="text-xs text-fg-muted whitespace-nowrap">
            {matchCount}/{totalCount}
          </span>
        )}

        <button
          onClick={onToggleActiveOnly}
          aria-pressed={!activeOnly}
          className={`flex items-center gap-1 px-2 py-1.5 text-xs rounded-md border cursor-pointer transition-colors whitespace-nowrap ${
            activeOnly
              ? 'bg-transparent border-border-default text-fg-muted hover:text-fg-primary hover:bg-surface-hover'
              : 'bg-surface-hover border-border-default text-fg-primary'
          }`}
          title={activeOnly ? 'Showing active only — click to show all' : 'Showing all — click to show active only'}
        >
          {activeOnly ? <Eye size={14} /> : <EyeOff size={14} />}
          {!isMobile && <span>{activeOnly ? 'Active' : 'All'}</span>}
        </button>

        <button
          onClick={onReorganize}
          className="flex items-center gap-1 px-2 py-1.5 text-xs bg-transparent border border-border-default rounded-md text-fg-muted hover:text-fg-primary hover:bg-surface-hover cursor-pointer transition-colors"
          aria-label="Reorganize layout"
          title="Reorganize layout"
        >
          <RotateCcw size={14} />
          {!isMobile && <span>Reorganize</span>}
        </button>

        {hasActiveFilters && (
          <button
            onClick={onResetFilters}
            className="px-2 py-1.5 text-xs bg-transparent border border-border-default rounded-md text-fg-muted hover:text-fg-primary hover:bg-surface-hover cursor-pointer transition-colors"
            aria-label="Reset filters"
          >
            Reset
          </button>
        )}
      </div>

      {/* Filter chips */}
      <div className="flex gap-1.5 overflow-x-auto pb-0.5 -mb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {FILTER_CHIPS.map((chip) => {
          const isActive = activeFilters.has(chip.type);
          const count = stats[chip.type + 's'] ?? stats[chip.type] ?? 0;
          return (
            <button
              key={chip.type}
              onClick={() => onToggleFilter(chip.type)}
              aria-pressed={isActive}
              className={`flex items-center gap-1 px-2.5 py-2 text-xs rounded-full border cursor-pointer transition-all whitespace-nowrap shrink-0 min-h-[44px] ${
                isActive
                  ? 'border-border-default bg-surface-hover text-fg-primary'
                  : 'border-transparent bg-transparent text-fg-muted opacity-50'
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${chip.color} ${isActive ? '' : 'opacity-30'}`} />
              {isMobile ? chip.shortLabel : chip.label}
              <span className="text-fg-muted">({count})</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
