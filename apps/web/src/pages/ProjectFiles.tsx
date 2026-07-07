import type { RepoBranch } from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import { GitBranch } from 'lucide-react';
import { type FC, useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';

import { BrowseView } from '../components/project-files/BrowseView';
import { ChangesView } from '../components/project-files/ChangesView';
import { getRepoBranches } from '../lib/api';
import { ApiClientError } from '../lib/api/client';

type Mode = 'changes' | 'browse';

export const ProjectFiles: FC = () => {
  const { id: projectId } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  const [branches, setBranches] = useState<RepoBranch[] | null>(null);
  const [loadingBranches, setLoadingBranches] = useState(true);
  const [branchesError, setBranchesError] = useState<string | null>(null);

  const defaultBranch = useMemo(
    () => branches?.find((b) => b.isDefault)?.name ?? branches?.[0]?.name ?? null,
    [branches]
  );

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoadingBranches(true);
    setBranchesError(null);
    getRepoBranches(projectId)
      .then((res) => !cancelled && setBranches(res.branches))
      .catch((err: unknown) =>
        !cancelled &&
        setBranchesError(err instanceof ApiClientError ? err.message : 'Failed to load branches')
      )
      .finally(() => !cancelled && setLoadingBranches(false));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const ref = searchParams.get('ref') ?? defaultBranch ?? '';
  const base = searchParams.get('base') ?? defaultBranch ?? '';
  const path = searchParams.get('path') ?? '';
  const urlMode = searchParams.get('mode') as Mode | null;
  // Default to Changes for non-default branches (review agent output); else Browse.
  const mode: Mode = urlMode ?? (ref && ref !== defaultBranch ? 'changes' : 'browse');

  const update = useCallback(
    (next: { ref?: string; mode?: Mode; path?: string; base?: string }) => {
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (next.ref !== undefined) p.set('ref', next.ref);
          if (next.base !== undefined) p.set('base', next.base);
          if (next.mode !== undefined) p.set('mode', next.mode);
          if (next.path !== undefined) {
            if (next.path) p.set('path', next.path);
            else p.delete('path');
          }
          return p;
        },
        { replace: false }
      );
    },
    [setSearchParams]
  );

  const onSelectBranch = useCallback(
    (branch: string) => {
      // Reset path; default mode per selected branch.
      update({ ref: branch, path: '', mode: branch !== defaultBranch ? 'changes' : 'browse' });
    },
    [update, defaultBranch]
  );

  const openFileInBrowse = useCallback(
    (filePath: string) => update({ mode: 'browse', path: filePath }),
    [update]
  );

  if (loadingBranches && !branches) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
        <Spinner />
      </div>
    );
  }
  if (branchesError) {
    return (
      <p role="alert" style={{ color: 'var(--color-error, #dc2626)', padding: 24 }}>
        {branchesError}
      </p>
    );
  }
  if (!branches || branches.length === 0 || !projectId) {
    return (
      <p style={{ padding: 24, color: 'var(--text-secondary, #999)' }}>
        No branches found for this repository.
      </p>
    );
  }

  const onDefault = ref === defaultBranch;

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 1,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 8,
          padding: '10px 12px',
          background: 'var(--bg-primary, #1a1a1a)',
          borderBottom: '1px solid var(--border-subtle, #2a2a2a)',
        }}
      >
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <GitBranch size={16} style={{ opacity: 0.7 }} />
          <span className="sr-only">Branch</span>
          <select
            aria-label="Branch"
            value={ref}
            onChange={(e) => onSelectBranch(e.target.value)}
            style={{
              maxWidth: 220,
              background: 'var(--bg-secondary, #242424)',
              color: 'inherit',
              border: '1px solid var(--border-subtle, #2a2a2a)',
              borderRadius: 6,
              padding: '4px 8px',
              fontSize: 13,
            }}
          >
            {branches.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
                {b.isDefault ? '  (default)' : ''}
              </option>
            ))}
          </select>
        </label>

        <div role="tablist" aria-label="View mode" style={{ display: 'inline-flex', gap: 4, marginLeft: 'auto' }}>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'changes'}
            disabled={onDefault}
            title={onDefault ? 'Select a non-default branch to see changes' : undefined}
            onClick={() => update({ mode: 'changes' })}
            style={tabStyle(mode === 'changes', onDefault)}
          >
            Changes
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'browse'}
            onClick={() => update({ mode: 'browse' })}
            style={tabStyle(mode === 'browse', false)}
          >
            Browse
          </button>
        </div>
      </div>

      {mode === 'changes' && !onDefault ? (
        <ChangesView projectId={projectId} head={ref} base={base} onOpenFile={openFileInBrowse} />
      ) : (
        <BrowseView projectId={projectId} ref={ref} path={path} onNavigate={(p) => update({ mode: 'browse', path: p })} />
      )}
    </div>
  );
};

function tabStyle(active: boolean, disabled: boolean): React.CSSProperties {
  return {
    padding: '4px 12px',
    fontSize: 13,
    borderRadius: 6,
    border: '1px solid var(--border-subtle, #2a2a2a)',
    background: active ? 'var(--color-accent, #2563eb)' : 'var(--bg-secondary, #242424)',
    color: active ? '#fff' : 'var(--text-primary, #e5e5e5)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}
