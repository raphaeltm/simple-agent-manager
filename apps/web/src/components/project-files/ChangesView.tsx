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

const STATUS_LABEL: Record<RepoCompareFile['status'], string> = {
  added: 'A',
  modified: 'M',
  removed: 'D',
  renamed: 'R',
};

const STATUS_COLOR: Record<RepoCompareFile['status'], string> = {
  added: 'var(--color-success, #16a34a)',
  modified: 'var(--color-warning, #ca8a04)',
  removed: 'var(--color-error, #dc2626)',
  renamed: 'var(--color-info, #2563eb)',
};

const FileRow: FC<{ file: RepoCompareFile; onOpenFile: (path: string) => void }> = ({
  file,
  onOpenFile,
}) => {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{ borderBottom: '1px solid var(--border-subtle, #2a2a2a)' }}>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '10px 12px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          color: 'var(--text-primary, #e5e5e5)',
        }}
      >
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <span
          aria-hidden
          style={{ color: STATUS_COLOR[file.status], fontFamily: 'monospace', fontWeight: 600, width: 14 }}
        >
          {STATUS_LABEL[file.status]}
        </span>
        <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', fontSize: 13 }}>{file.path}</span>
        <span style={{ color: 'var(--color-success, #16a34a)', fontSize: 12 }}>+{file.additions}</span>
        <span style={{ color: 'var(--color-error, #dc2626)', fontSize: 12 }}>−{file.deletions}</span>
      </button>
      {expanded && (
        <div style={{ padding: '0 8px 8px' }}>
          {file.isBinary ? (
            <p style={{ color: 'var(--text-secondary, #999)', fontSize: 13, padding: 8 }}>
              Binary file — no textual diff.{' '}
              <button type="button" className="link" onClick={() => onOpenFile(file.path)}>
                View file
              </button>
            </p>
          ) : file.patchTruncated || !file.patch ? (
            <p style={{ color: 'var(--text-secondary, #999)', fontSize: 13, padding: 8 }}>
              Diff too large to display.{' '}
              <button type="button" className="link" onClick={() => onOpenFile(file.path)}>
                View file
              </button>
            </p>
          ) : (
            <>
              <DiffRenderer diff={file.patch} />
              <button
                type="button"
                className="link"
                style={{ fontSize: 12, marginTop: 6 }}
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
      <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
        <Spinner />
      </div>
    );
  }
  if (error) {
    return (
      <p role="alert" style={{ color: 'var(--color-error, #dc2626)', padding: 16 }}>
        {error}
      </p>
    );
  }
  if (!data || data.files.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-secondary, #999)' }}>
        <FileDiff size={28} style={{ opacity: 0.5 }} />
        <p style={{ marginTop: 8 }}>
          No changes — <code>{head}</code> is up to date with <code>{base}</code>.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 12px',
          fontSize: 13,
          color: 'var(--text-secondary, #999)',
          borderBottom: '1px solid var(--border-subtle, #2a2a2a)',
        }}
      >
        <span>
          Comparing <code>{base}</code> ← <code>{head}</code>
        </span>
        <span style={{ marginLeft: 'auto', color: 'var(--color-success, #16a34a)' }}>
          +{data.totalAdditions}
        </span>
        <span style={{ color: 'var(--color-error, #dc2626)' }}>−{data.totalDeletions}</span>
      </div>
      <p style={{ padding: '6px 12px', fontSize: 12, color: 'var(--text-secondary, #999)' }}>
        {summary}
        {data.truncated ? ' (list truncated — very large diff)' : ''}
      </p>
      {data.files.map((f) => (
        <FileRow key={f.path} file={f} onOpenFile={onOpenFile} />
      ))}
    </div>
  );
};
