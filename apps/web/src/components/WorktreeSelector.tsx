import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorktreeInfo } from '@simple-agent-manager/shared';
import { Button } from '@simple-agent-manager/ui';
import { Check, GitFork, Plus, Trash2 } from 'lucide-react';

interface WorktreeSelectorProps {
  worktrees: WorktreeInfo[];
  activeWorktree: string | null;
  loading?: boolean;
  isMobile?: boolean;
  onSelect: (worktreePath: string | null) => void;
  onCreate: (request: {
    branch: string;
    createBranch: boolean;
    baseBranch?: string;
  }) => Promise<void>;
  onRemove: (path: string, force: boolean) => Promise<void>;
}

function worktreeLabel(worktree: WorktreeInfo): string {
  if (worktree.branch && !/^[0-9a-f]{7,40}$/i.test(worktree.branch)) {
    return worktree.branch;
  }
  return worktree.headCommit || worktree.branch || 'detached';
}

export function WorktreeSelector({
  worktrees,
  activeWorktree,
  loading = false,
  isMobile = false,
  onSelect,
  onCreate,
  onRemove,
}: WorktreeSelectorProps) {
  const [open, setOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [branch, setBranch] = useState('');
  const [createBranch, setCreateBranch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const active = useMemo(
    () =>
      worktrees.find((w) => w.path === activeWorktree) ??
      worktrees.find((w) => w.isPrimary) ??
      null,
    [activeWorktree, worktrees]
  );

  // Reset transient state when popover closes
  useEffect(() => {
    if (!open) {
      setShowCreate(false);
      setBranch('');
      setCreateBranch(false);
      setError(null);
    }
  }, [open]);

  // Click-outside to close on desktop
  useEffect(() => {
    if (!open || isMobile) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, isMobile]);

  const handleCreate = async () => {
    const nextBranch = branch.trim();
    if (!nextBranch) return;
    try {
      setBusy(true);
      setError(null);
      await onCreate({ branch: nextBranch, createBranch });
      setBranch('');
      setCreateBranch(false);
      setShowCreate(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create worktree');
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (worktree: WorktreeInfo) => {
    if (worktree.isPrimary) return;
    const message = worktree.isDirty
      ? `Worktree '${worktreeLabel(worktree)}' has ${worktree.dirtyFileCount} dirty file${worktree.dirtyFileCount === 1 ? '' : 's'}. Force remove?`
      : `Remove worktree '${worktreeLabel(worktree)}'?`;
    if (!window.confirm(message)) return;

    try {
      setBusy(true);
      setError(null);
      await onRemove(worktree.path, worktree.isDirty);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove worktree');
    } finally {
      setBusy(false);
    }
  };

  const activeLabel = active ? worktreeLabel(active) : 'primary';
  const triggerAriaLabel = `Switch worktree (${activeLabel})`;

  const isActive = (wt: WorktreeInfo) =>
    wt.path === activeWorktree || (wt.isPrimary && !activeWorktree);

  return (
    <div ref={popoverRef} style={{ position: 'relative' }}>
      <button
        id="worktree-selector-trigger"
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={loading || busy}
        aria-label={triggerAriaLabel}
        style={{
          minHeight: isMobile ? 44 : 56,
          minWidth: isMobile ? 44 : undefined,
          borderRadius: isMobile ? 8 : 10,
          border: isMobile ? 'none' : '1px solid var(--sam-color-border-default)',
          background: isMobile ? 'none' : 'var(--sam-color-bg-surface)',
          color: 'var(--sam-color-fg-primary)',
          padding: isMobile ? '8px' : '0 14px',
          fontSize: 13,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {isMobile ? <GitFork size={18} /> : `Worktree: ${activeLabel}`}
      </button>

      {open && (
        <div
          style={
            isMobile
              ? { position: 'fixed', inset: 0, zIndex: 90 }
              : undefined
          }
        >
          {isMobile && (
            <button
              type="button"
              aria-label="Close worktree menu"
              onClick={() => setOpen(false)}
              style={{
                position: 'absolute',
                inset: 0,
                border: 'none',
                background: 'var(--sam-color-bg-overlay, rgba(0, 0, 0, 0.45))',
                cursor: 'pointer',
              }}
            />
          )}
          <div
            style={{
              position: 'absolute',
              top: isMobile ? undefined : '100%',
              right: isMobile ? 8 : 0,
              left: isMobile ? 8 : undefined,
              bottom: isMobile ? 8 : undefined,
              zIndex: isMobile ? 91 : 80,
              width: isMobile ? undefined : 280,
              marginTop: isMobile ? 0 : 6,
              borderRadius: 'var(--sam-radius-md, 10px)',
              border: '1px solid var(--sam-color-border-default)',
              background: 'var(--sam-color-bg-surface)',
              padding: 8,
              maxHeight: isMobile ? '50vh' : 320,
              overflow: 'auto',
            }}
          >
            {/* Header row */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 4,
                padding: '0 4px',
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  color: 'var(--sam-color-fg-muted)',
                }}
              >
                Worktrees
              </span>
              <button
                type="button"
                aria-label={showCreate ? 'Cancel new worktree' : 'New worktree'}
                onClick={() => setShowCreate((v) => !v)}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  border: 'none',
                  background: showCreate
                    ? 'var(--sam-color-bg-surface-hover, rgba(255,255,255,0.06))'
                    : 'transparent',
                  color: 'var(--sam-color-fg-muted)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'transform 150ms ease',
                  transform: showCreate ? 'rotate(45deg)' : 'none',
                }}
              >
                <Plus size={14} />
              </button>
            </div>

            {/* Worktree list */}
            <div style={{ display: 'grid', gap: 2 }}>
              {worktrees.map((wt) => {
                const selected = isActive(wt);
                return (
                  <div
                    key={wt.path}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      borderRadius: 6,
                      padding: '0 4px',
                      background: selected
                        ? 'var(--sam-color-bg-surface-hover, rgba(255,255,255,0.06))'
                        : 'transparent',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(wt.isPrimary ? null : wt.path);
                        setOpen(false);
                      }}
                      aria-label={`${worktreeLabel(wt)}${wt.isPrimary ? ' (primary)' : ''}`}
                      style={{
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        minHeight: 36,
                        border: 'none',
                        background: 'transparent',
                        color: 'var(--sam-color-fg-primary)',
                        padding: '4px 0',
                        cursor: 'pointer',
                        fontSize: 13,
                        textAlign: 'left',
                      }}
                    >
                      <Check
                        size={14}
                        style={{
                          flexShrink: 0,
                          opacity: selected ? 1 : 0,
                          color: 'var(--sam-color-accent-primary)',
                        }}
                      />
                      <span
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {worktreeLabel(wt)}
                      </span>
                      {wt.isPrimary && (
                        <span
                          style={{
                            fontSize: 10,
                            color: 'var(--sam-color-fg-muted)',
                            flexShrink: 0,
                          }}
                        >
                          primary
                        </span>
                      )}
                      {wt.isDirty && wt.dirtyFileCount > 0 && (
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 600,
                            color: 'var(--sam-color-warning, #f59e0b)',
                            flexShrink: 0,
                          }}
                        >
                          {wt.dirtyFileCount}
                        </span>
                      )}
                    </button>
                    {!wt.isPrimary && (
                      <button
                        type="button"
                        aria-label={`Remove ${worktreeLabel(wt)}`}
                        onClick={() => void handleRemove(wt)}
                        disabled={busy}
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 6,
                          border: 'none',
                          background: 'transparent',
                          color: 'var(--sam-color-fg-muted)',
                          cursor: busy ? 'not-allowed' : 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                          opacity: busy ? 0.5 : 1,
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Collapsible creation form */}
            {showCreate && (
              <div
                style={{
                  marginTop: 6,
                  borderTop: '1px solid var(--sam-color-border-default)',
                  paddingTop: 8,
                  display: 'grid',
                  gap: 6,
                }}
              >
                <input
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="branch name"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleCreate();
                  }}
                  style={{
                    minHeight: 36,
                    borderRadius: 6,
                    border: '1px solid var(--sam-color-border-default)',
                    background: 'var(--sam-color-bg-canvas)',
                    color: 'var(--sam-color-fg-primary)',
                    padding: '0 10px',
                    fontSize: 13,
                  }}
                />
                <label
                  style={{
                    display: 'flex',
                    gap: 6,
                    alignItems: 'center',
                    fontSize: 12,
                    color: 'var(--sam-color-fg-muted)',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={createBranch}
                    onChange={(e) => setCreateBranch(e.target.checked)}
                  />
                  Create new branch
                </label>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void handleCreate()}
                  disabled={busy || !branch.trim()}
                  loading={busy}
                  style={{ width: '100%' }}
                >
                  Create Worktree
                </Button>
              </div>
            )}

            {error && (
              <div
                style={{
                  marginTop: 6,
                  color: 'var(--sam-color-danger)',
                  fontSize: 12,
                  padding: '0 4px',
                }}
              >
                {error}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
