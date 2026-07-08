import type { RepoCompareFile, RepoCompareResponse } from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import { ChevronDown, ChevronRight, FileDiff } from 'lucide-react';
import { type FC, useEffect, useMemo, useState } from 'react';

import { getRepoCompare } from '../../lib/api';
import { ApiClientError } from '../../lib/api/client';
import { DiffRenderer } from '../shared-file-viewer';

interface ChangesViewProps {
  projectId: string;
  /** Head branch being reviewed. */
  head: string;
  /** Base branch to compare against (default branch). */
  base: string;
  /** Navigate to a file in Browse mode (e.g. "view whole file"). */
  onOpenFile: (path: string) => void;
}

const STATUS_LABEL_FULL: Record<RepoCompareFile['status'], string> = {
  added: 'added',
  modified: 'modified',
  removed: 'removed',
  renamed: 'renamed',
};

const STATUS_LABEL: Record<RepoCompareFile['status'], string> = {
  added: 'A',
  modified: 'M',
  removed: 'D',
  renamed: 'R',
};

const STATUS_COLOR: Record<RepoCompareFile['status'], string> = {
  added: 'var(--sam-color-success)',
  modified: 'var(--sam-color-warning)',
  removed: 'var(--sam-color-danger)',
  renamed: 'var(--sam-color-info)',
};

const FileRow: FC<{ file: RepoCompareFile; onOpenFile: (path: string) => void }> = ({
  file,
  onOpenFile,
}) => {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border-b border-border-default">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-2 px-3 py-2.5 min-h-[44px] bg-transparent border-none cursor-pointer text-left text-fg-primary hover:bg-surface-hover transition-colors"
      >
        {expanded ? <ChevronDown size={14} className="shrink-0 text-fg-muted" /> : <ChevronRight size={14} className="shrink-0 text-fg-muted" />}
        <span
          aria-hidden
          className="text-xs font-mono font-semibold w-4 text-center shrink-0"
          style={{ color: STATUS_COLOR[file.status] }}
        >
          {STATUS_LABEL[file.status]}
        </span>
        <span className="sr-only">{STATUS_LABEL_FULL[file.status]} — </span>
        <span className="flex-1 min-w-0 break-all text-[13px]">{file.path}</span>
        <span className="text-xs tabular-nums text-success shrink-0">+{file.additions}</span>
        <span className="text-xs tabular-nums text-danger shrink-0">−{file.deletions}</span>
      </button>
      {expanded && (
        <div className="px-2 pb-2">
          {file.isBinary ? (
            <p className="text-fg-muted text-[13px] p-2">
              Binary file — no textual diff.{' '}
              <button
                type="button"
                className="bg-transparent border-none p-0 text-accent underline cursor-pointer text-xs"
                onClick={() => onOpenFile(file.path)}
              >
                View file
              </button>
            </p>
          ) : file.patchTruncated || !file.patch ? (
            <p className="text-fg-muted text-[13px] p-2">
              Diff too large to display.{' '}
              <button
                type="button"
                className="bg-transparent border-none p-0 text-accent underline cursor-pointer text-xs"
                onClick={() => onOpenFile(file.path)}
              >
                View file
              </button>
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <DiffRenderer diff={file.patch} />
              </div>
              <button
                type="button"
                className="bg-transparent border-none p-0 text-accent underline cursor-pointer text-xs mt-1.5"
                onClick={() => onOpenFile(file.path)}
              >
                View whole file
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export const ChangesView: FC<ChangesViewProps> = ({ projectId, head, base, onOpenFile }) => {
  const [data, setData] = useState<RepoCompareResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getRepoCompare(projectId, head, base)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof ApiClientError ? err.message : 'Failed to load changes');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, head, base]);

  const summary = useMemo(() => {
    if (!data) return null;
    return `${data.filesChanged} file${data.filesChanged === 1 ? '' : 's'} changed`;
  }, [data]);

  if (loading && !data) {
    return (
      <div className="flex justify-center p-10">
        <Spinner />
      </div>
    );
  }
  if (error) {
    return (
      <p role="alert" className="p-4 text-danger-fg">
        {error}
      </p>
    );
  }
  if (!data || data.files.length === 0) {
    return (
      <div className="text-center p-10 text-fg-muted">
        <FileDiff size={28} className="opacity-50 mx-auto" />
        <p className="mt-2">
          No changes — <code className="text-fg-primary">{head}</code> is up to date with <code className="text-fg-primary">{base}</code>.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-3 px-3 py-2.5 text-[13px] text-fg-muted border-b border-border-default">
        <span>
          Comparing <code className="text-fg-primary">{base}</code> ← <code className="text-fg-primary">{head}</code>
        </span>
        <span className="ml-auto text-xs tabular-nums text-success">+{data.totalAdditions}</span>
        <span className="text-xs tabular-nums text-danger">−{data.totalDeletions}</span>
      </div>
      <p className="px-3 py-1.5 text-xs text-fg-muted">
        {summary}
        {data.truncated ? ' (list truncated — very large diff)' : ''}
      </p>
      {data.files.map((f) => (
        <FileRow key={f.path} file={f} onOpenFile={onOpenFile} />
      ))}
    </div>
  );
};
