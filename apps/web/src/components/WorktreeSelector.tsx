import { FC, useState, useRef, useEffect } from 'react';
import { GitBranch, ChevronDown, Plus, Trash2, Star } from 'lucide-react';
import type { WorktreeInfo, WorktreeCreateRequest } from '@simple-agent-manager/shared';

interface WorktreeSelectorProps {
  worktrees: WorktreeInfo[];
  activeWorktreePath: string | null;
  loading: boolean;
  onSelect: (path: string) => void;
  onCreate: (req: WorktreeCreateRequest) => Promise<WorktreeInfo>;
  onRemove: (path: string, force?: boolean) => Promise<string[]>;
  onOpenCreateDialog: () => void;
}

/**
 * Dropdown selector for switching between git worktrees.
 * Shows in the workspace header next to repository/branch info.
 */
export const WorktreeSelector: FC<WorktreeSelectorProps> = ({
  worktrees,
  activeWorktreePath,
  loading,
  onSelect,
  onRemove,
  onOpenCreateDialog,
}) => {
  const [open, setOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const activeWorktree = worktrees.find(wt => wt.path === activeWorktreePath)
    ?? worktrees.find(wt => wt.isPrimary)
    ?? worktrees[0];

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirmRemove(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Don't render if only one worktree (the primary)
  if (worktrees.length <= 1 && !loading) {
    return null;
  }

  const displayLabel = activeWorktree
    ? activeWorktree.branch || activeWorktree.headCommit
    : 'Worktrees';

  const handleSelect = (path: string) => {
    onSelect(path);
    setOpen(false);
    setConfirmRemove(null);
  };

  const handleRemoveClick = (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    const wt = worktrees.find(w => w.path === path);
    if (wt?.isDirty) {
      setConfirmRemove(path);
    } else {
      onRemove(path);
      setConfirmRemove(null);
    }
  };

  const handleConfirmRemove = (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    onRemove(path, true);
    setConfirmRemove(null);
  };

  return (
    <div ref={dropdownRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          padding: '4px 8px',
          background: 'var(--color-bg-secondary, #1e1e2e)',
          border: '1px solid var(--color-border, #333)',
          borderRadius: '4px',
          color: 'var(--color-text-primary, #cdd6f4)',
          cursor: 'pointer',
          fontSize: '13px',
          whiteSpace: 'nowrap',
        }}
        title="Switch worktree"
      >
        <GitBranch size={14} />
        <span style={{ maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {displayLabel}
        </span>
        {worktrees.length > 1 && (
          <span style={{ opacity: 0.5, fontSize: '11px' }}>({worktrees.length})</span>
        )}
        <ChevronDown size={12} />
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: '4px',
            minWidth: '280px',
            maxHeight: '320px',
            overflowY: 'auto',
            background: 'var(--color-bg-primary, #11111b)',
            border: '1px solid var(--color-border, #333)',
            borderRadius: '6px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
            zIndex: 100,
          }}
        >
          {/* Worktree list */}
          {worktrees.map(wt => {
            const isActive = wt.path === activeWorktree?.path;
            const label = wt.branch || wt.headCommit;

            return (
              <div
                key={wt.path}
                onClick={() => handleSelect(wt.path)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '8px 12px',
                  cursor: 'pointer',
                  background: isActive
                    ? 'var(--color-bg-hover, rgba(137,180,250,0.1))'
                    : 'transparent',
                  borderBottom: '1px solid var(--color-border, #222)',
                }}
                onMouseEnter={e => {
                  if (!isActive) (e.currentTarget as HTMLDivElement).style.background = 'var(--color-bg-hover, rgba(255,255,255,0.05))';
                }}
                onMouseLeave={e => {
                  if (!isActive) (e.currentTarget as HTMLDivElement).style.background = 'transparent';
                }}
              >
                <GitBranch size={14} style={{ flexShrink: 0, opacity: 0.6 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px',
                    fontSize: '13px',
                    color: 'var(--color-text-primary, #cdd6f4)',
                  }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {label}
                    </span>
                    {wt.isPrimary && (
                      <Star size={10} style={{ flexShrink: 0, color: 'var(--color-accent, #f9e2af)' }} />
                    )}
                    {wt.isDirty && (
                      <span style={{
                        fontSize: '10px',
                        color: 'var(--color-warning, #fab387)',
                        flexShrink: 0,
                      }}>
                        {wt.dirtyFileCount}M
                      </span>
                    )}
                  </div>
                  <div style={{
                    fontSize: '11px',
                    color: 'var(--color-text-secondary, #6c7086)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {wt.headCommit}
                  </div>
                </div>

                {/* Remove button (not for primary) */}
                {!wt.isPrimary && (
                  <div style={{ flexShrink: 0 }}>
                    {confirmRemove === wt.path ? (
                      <button
                        onClick={(e) => handleConfirmRemove(e, wt.path)}
                        style={{
                          padding: '2px 6px',
                          fontSize: '10px',
                          background: 'var(--color-error, #f38ba8)',
                          color: '#11111b',
                          border: 'none',
                          borderRadius: '3px',
                          cursor: 'pointer',
                        }}
                        title={`Force remove (${wt.dirtyFileCount} dirty files)`}
                      >
                        Force
                      </button>
                    ) : (
                      <button
                        onClick={(e) => handleRemoveClick(e, wt.path)}
                        style={{
                          display: 'flex',
                          padding: '4px',
                          background: 'none',
                          border: 'none',
                          color: 'var(--color-text-secondary, #6c7086)',
                          cursor: 'pointer',
                          borderRadius: '3px',
                        }}
                        title="Remove worktree"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* New worktree action */}
          <div
            onClick={() => {
              setOpen(false);
              onOpenCreateDialog();
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 12px',
              cursor: 'pointer',
              color: 'var(--color-accent, #89b4fa)',
              fontSize: '13px',
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLDivElement).style.background = 'var(--color-bg-hover, rgba(255,255,255,0.05))';
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLDivElement).style.background = 'transparent';
            }}
          >
            <Plus size={14} />
            <span>New worktree...</span>
          </div>
        </div>
      )}
    </div>
  );
};
