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
      <div className="flex justify-center p-10">
        <Spinner />
      </div>
    );
  }
  if (branchesError) {
    return (
      <p role="alert" className="p-6 text-danger-fg">
        {branchesError}
      </p>
    );
  }
  if (!branches || branches.length === 0 || !projectId) {
    return (
      <p className="p-6 text-fg-muted">
        No branches found for this repository.
      </p>
    );
  }

  const onDefault = ref === defaultBranch;

  return (
    <div className="h-full overflow-auto">
      {/* Sticky header bar */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 px-3 py-2.5 bg-surface border-b border-border-default">
        <label className="inline-flex items-center gap-1.5 min-w-0">
          <GitBranch size={14} className="text-fg-muted shrink-0" />
          <span className="sr-only">Branch</span>
          <select
            aria-label="Branch"
            value={ref}
            onChange={(e) => onSelectBranch(e.target.value)}
            className="max-w-[220px] text-[13px] rounded-md px-2 py-1 border border-border-default text-fg-primary bg-canvas focus:outline-none focus:ring-1 focus:ring-accent"
          >
            {branches.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
                {b.isDefault ? '  (default)' : ''}
              </option>
            ))}
          </select>
        </label>

        <div role="tablist" aria-label="View mode" className="inline-flex gap-1 ml-auto">
          <button
            type="button"
            role="tab"
            id="files-tab-changes"
            aria-controls="files-tabpanel"
            aria-selected={mode === 'changes'}
            aria-disabled={onDefault}
            disabled={onDefault}
            title={onDefault ? 'Select a non-default branch to see changes' : undefined}
            onClick={() => update({ mode: 'changes' })}
            className={`text-[13px] px-3 py-1 rounded-md border cursor-pointer transition-colors
              ${mode === 'changes'
                ? 'bg-accent text-fg-on-accent border-accent'
                : 'bg-canvas text-fg-muted border-border-default hover:text-fg-primary hover:bg-surface-hover'}
              ${onDefault ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            Changes
          </button>
          <button
            type="button"
            role="tab"
            id="files-tab-browse"
            aria-controls="files-tabpanel"
            aria-selected={mode === 'browse'}
            onClick={() => update({ mode: 'browse' })}
            className={`text-[13px] px-3 py-1 rounded-md border cursor-pointer transition-colors
              ${mode === 'browse'
                ? 'bg-accent text-fg-on-accent border-accent'
                : 'bg-canvas text-fg-muted border-border-default hover:text-fg-primary hover:bg-surface-hover'}`}
          >
            Browse
          </button>
        </div>
      </div>

      <div
        role="tabpanel"
        id="files-tabpanel"
        aria-labelledby={mode === 'changes' && !onDefault ? 'files-tab-changes' : 'files-tab-browse'}
      >
        {mode === 'changes' && !onDefault ? (
          <ChangesView projectId={projectId} head={ref} base={base} onOpenFile={openFileInBrowse} />
        ) : (
          <BrowseView projectId={projectId} ref={ref} path={path} onNavigate={(p) => update({ mode: 'browse', path: p })} />
        )}
      </div>
    </div>
  );
};
