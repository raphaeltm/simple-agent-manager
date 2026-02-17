import { useMemo, useState } from 'react';
import type { WorktreeInfo } from '@simple-agent-manager/shared';
import { GitBranch } from 'lucide-react';

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
  const [branch, setBranch] = useState('');
  const [createBranch, setCreateBranch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = useMemo(
    () =>
      worktrees.find((w) => w.path === activeWorktree) ??
      worktrees.find((w) => w.isPrimary) ??
      null,
    [activeWorktree, worktrees]
  );

  const handleCreate = async () => {
    const nextBranch = branch.trim();
    if (!nextBranch) return;
    try {
      setBusy(true);
      setError(null);
      await onCreate({ branch: nextBranch, createBranch });
      setBranch('');
      setCreateBranch(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create worktree');
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (worktree: WorktreeInfo) => {
    if (worktree.isPrimary) return;
    const force = worktree.isDirty
      ? window.confirm(`Worktree has ${worktree.dirtyFileCount} dirty files. Force remove?`)
      : window.confirm(`Remove worktree '${worktreeLabel(worktree)}'?`);
    if (!force && worktree.isDirty) return;
    if (!worktree.isDirty && !window.confirm(`Confirm remove '${worktreeLabel(worktree)}'.`))
      return;

    try {
      setBusy(true);
      setError(null);
      await onRemove(worktree.path, worktree.isDirty ? true : false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove worktree');
    } finally {
      setBusy(false);
    }
  };

  const activeLabel = active ? worktreeLabel(active) : 'primary';
  const triggerAriaLabel = `Switch worktree (${activeLabel})`;

  return (
    <div style={{ position: 'relative' }}>
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
        {isMobile ? <GitBranch size={18} /> : `Worktree: ${activeLabel}`}
      </button>

      {open && (
        <div
          style={
            isMobile
              ? {
                  position: 'fixed',
                  inset: 0,
                  zIndex: 90,
                }
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
                background: 'rgba(0, 0, 0, 0.45)',
                cursor: 'pointer',
              }}
            />
          )}
          <div
            style={{
              position: isMobile ? 'absolute' : 'absolute',
              top: isMobile ? undefined : '100%',
              right: isMobile ? 8 : 0,
              left: isMobile ? 8 : undefined,
              bottom: isMobile ? 8 : undefined,
              zIndex: isMobile ? 91 : 80,
              width: isMobile ? undefined : 320,
              marginTop: isMobile ? 0 : 8,
              borderRadius: 10,
              border: '1px solid var(--sam-color-border-default)',
              background: 'var(--sam-color-bg-surface)',
              padding: 10,
              maxHeight: isMobile ? '70vh' : 420,
              overflow: 'auto',
            }}
          >
          <div style={{ display: 'grid', gap: 6 }}>
            {worktrees.map((wt) => (
              <div
                key={wt.path}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <button
                  type="button"
                    onClick={() => {
                      onSelect(wt.isPrimary ? null : wt.path);
                      setOpen(false);
                    }}
                  style={{
                    flex: 1,
                    textAlign: 'left',
                    minHeight: 44,
                    borderRadius: 8,
                    border: '1px solid var(--sam-color-border-default)',
                    background:
                      wt.path === activeWorktree || (wt.isPrimary && !activeWorktree)
                        ? 'var(--sam-color-accent-primary)'
                        : 'transparent',
                    color:
                      wt.path === activeWorktree || (wt.isPrimary && !activeWorktree)
                        ? '#fff'
                        : 'var(--sam-color-fg-primary)',
                    padding: '8px 10px',
                    cursor: 'pointer',
                  }}
                >
                  {worktreeLabel(wt)} {wt.isPrimary ? '(primary)' : ''}{' '}
                  {wt.isPrunable ? '(prunable)' : ''}
                </button>
                {!wt.isPrimary && (
                  <button
                    type="button"
                    onClick={() => void handleRemove(wt)}
                    style={{
                      minHeight: 44,
                      borderRadius: 8,
                      border: '1px solid #f7768e',
                      color: '#f7768e',
                      background: 'transparent',
                      padding: '0 10px',
                      cursor: 'pointer',
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>

          <div
            style={{
              marginTop: 10,
              borderTop: '1px solid var(--sam-color-border-default)',
              paddingTop: 10,
            }}
          >
            <div style={{ display: 'grid', gap: 8 }}>
              <input
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder="branch name"
                style={{
                  minHeight: 44,
                  borderRadius: 8,
                  border: '1px solid var(--sam-color-border-default)',
                  background: 'var(--sam-color-bg-canvas)',
                  color: 'var(--sam-color-fg-primary)',
                  padding: '0 10px',
                }}
              />
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={createBranch}
                  onChange={(e) => setCreateBranch(e.target.checked)}
                />
                Create new branch
              </label>
              <button
                type="button"
                onClick={() => void handleCreate()}
                disabled={busy || !branch.trim()}
                style={{
                  minHeight: 56,
                  borderRadius: 8,
                  border: 'none',
                  background: 'var(--sam-color-accent-primary)',
                  color: '#fff',
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                New Worktree
              </button>
            </div>
            {error && <div style={{ marginTop: 8, color: '#f7768e', fontSize: 12 }}>{error}</div>}
          </div>
          </div>
        </div>
      )}
    </div>
  );
}
