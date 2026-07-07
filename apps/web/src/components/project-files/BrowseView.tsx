import type { RepoFileContent, RepoTreeEntry, RepoTreeResponse } from '@simple-agent-manager/shared';
import { Spinner } from '@simple-agent-manager/ui';
import { ChevronRight, Download, File as FileIcon, FileText, Folder, Image as ImageIcon, Search } from 'lucide-react';
import { type FC, useEffect, useMemo, useState } from 'react';

import { getRepoFile, getRepoTree, repoRawUrl } from '../../lib/api';
import { ApiClientError } from '../../lib/api/client';
import { detectLanguage, formatFileSize, isImageFile } from '../../lib/file-utils';
import { fuzzyFilterFiles } from '../../lib/fuzzy-match';
import { RenderedMarkdown, SyntaxHighlightedCode } from '../MarkdownRenderer';
import { ImageViewer } from '../shared-file-viewer';

interface BrowseViewProps {
  projectId: string;
  ref: string;
  /** Current path: '' = repo root dir, a dir path, or a blob path (file view). */
  path: string;
  onNavigate: (path: string) => void;
}

interface DirChild {
  name: string;
  type: 'tree' | 'blob';
  path: string;
  size?: number | null;
}

function isMarkdownPath(p: string): boolean {
  const lower = p.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.mdx');
}

/** Immediate children of `dir` derived from the full recursive tree. */
function childrenOf(entries: RepoTreeEntry[], dir: string): DirChild[] {
  const prefix = dir ? `${dir}/` : '';
  const seen = new Map<string, DirChild>();
  for (const e of entries) {
    if (prefix && !e.path.startsWith(prefix)) continue;
    const rest = e.path.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      seen.set(rest, { name: rest, type: e.type, path: e.path, size: e.size });
    } else {
      const name = rest.slice(0, slash);
      if (!seen.has(name)) seen.set(name, { name, type: 'tree', path: `${prefix}${name}` });
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.type !== b.type ? (a.type === 'tree' ? -1 : 1) : a.name.localeCompare(b.name)
  );
}

function Breadcrumbs({ path, onNavigate }: { path: string; onNavigate: (p: string) => void }) {
  const parts = path ? path.split('/') : [];
  let acc = '';
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2, fontSize: 13, padding: '8px 12px' }}>
      <button type="button" className="link" onClick={() => onNavigate('')}>
        /
      </button>
      {parts.map((part, i) => {
        acc = acc ? `${acc}/${part}` : part;
        const target = acc;
        return (
          <span key={target} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
            <ChevronRight size={12} style={{ opacity: 0.5 }} />
            <button
              type="button"
              className="link"
              style={{ overflowWrap: 'anywhere' }}
              onClick={() => onNavigate(target)}
              disabled={i === parts.length - 1}
            >
              {part}
            </button>
          </span>
        );
      })}
    </div>
  );
}

const FileViewer: FC<{ projectId: string; ref: string; path: string }> = ({ projectId, ref, path }) => {
  const [file, setFile] = useState<RepoFileContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showRawMarkdown, setShowRawMarkdown] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getRepoFile(projectId, ref, path)
      .then((f) => !cancelled && setFile(f))
      .catch((err: unknown) =>
        !cancelled && setError(err instanceof ApiClientError ? err.message : 'Failed to load file')
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectId, ref, path]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
        <Spinner />
      </div>
    );
  }
  if (error) {
    return <p role="alert" style={{ color: 'var(--color-error, #dc2626)', padding: 16 }}>{error}</p>;
  }
  if (!file) return null;

  if (file.content !== null) {
    if (isMarkdownPath(path) && !showRawMarkdown) {
      return (
        <div style={{ padding: 12 }}>
          <button type="button" className="link" style={{ fontSize: 12, marginBottom: 8 }} onClick={() => setShowRawMarkdown(true)}>
            View source
          </button>
          <RenderedMarkdown content={file.content} />
        </div>
      );
    }
    return (
      <div style={{ padding: 12 }}>
        {isMarkdownPath(path) && (
          <button type="button" className="link" style={{ fontSize: 12, marginBottom: 8 }} onClick={() => setShowRawMarkdown(false)}>
            View rendered
          </button>
        )}
        <SyntaxHighlightedCode content={file.content} language={detectLanguage(path)} />
      </div>
    );
  }

  const raw = repoRawUrl(projectId, ref, path);
  if (file.isBinary && isImageFile(path)) {
    return <ImageViewer src={raw} fileName={path} fileSize={file.size} />;
  }
  return (
    <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-secondary, #999)' }}>
      <FileIcon size={28} style={{ opacity: 0.5 }} />
      <p style={{ marginTop: 8 }}>
        {file.tooLarge ? 'File is too large to display inline' : 'Binary file'} ({formatFileSize(file.size)})
      </p>
      <a href={raw} download style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
        <Download size={16} /> Download
      </a>
    </div>
  );
};

export const BrowseView: FC<BrowseViewProps> = ({ projectId, ref, path, onNavigate }) => {
  const [tree, setTree] = useState<RepoTreeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getRepoTree(projectId, ref)
      .then((t) => !cancelled && setTree(t))
      .catch((err: unknown) =>
        !cancelled && setError(err instanceof ApiClientError ? err.message : 'Failed to load tree')
      )
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectId, ref]);

  const entries = tree?.entries ?? [];
  const isFile = useMemo(
    () => entries.some((e) => e.path === path && e.type === 'blob'),
    [entries, path]
  );
  const blobPaths = useMemo(() => entries.filter((e) => e.type === 'blob').map((e) => e.path), [entries]);
  const searchResults = useMemo(
    () => (query.trim() ? fuzzyFilterFiles(blobPaths, query, 50) : []),
    [blobPaths, query]
  );
  const dirChildren = useMemo(
    () => (isFile ? [] : childrenOf(entries, path)),
    [entries, path, isFile]
  );

  if (loading && !tree) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
        <Spinner />
      </div>
    );
  }
  if (error) {
    return <p role="alert" style={{ color: 'var(--color-error, #dc2626)', padding: 16 }}>{error}</p>;
  }
  if (entries.length === 0) {
    return <p style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary, #999)' }}>This repository is empty.</p>;
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px' }}>
        <Search size={16} style={{ opacity: 0.6 }} />
        <input
          type="search"
          placeholder="Search files by name…"
          aria-label="Search files by name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', color: 'inherit', outline: 'none', fontSize: 14 }}
        />
      </div>

      {query.trim() ? (
        <div>
          {searchResults.length === 0 ? (
            <p style={{ padding: 16, color: 'var(--text-secondary, #999)' }}>No files match “{query}”.</p>
          ) : (
            searchResults.map((r) => (
              <button
                key={r.path}
                type="button"
                onClick={() => {
                  setQuery('');
                  onNavigate(r.path);
                }}
                style={rowStyle}
              >
                <FileText size={16} style={{ opacity: 0.7 }} />
                <span style={{ overflowWrap: 'anywhere', fontSize: 13 }}>{r.path}</span>
              </button>
            ))
          )}
        </div>
      ) : isFile ? (
        <>
          <Breadcrumbs path={path} onNavigate={onNavigate} />
          <FileViewer projectId={projectId} ref={ref} path={path} />
        </>
      ) : (
        <>
          <Breadcrumbs path={path} onNavigate={onNavigate} />
          {tree?.truncated && (
            <p style={{ padding: '4px 12px', fontSize: 12, color: 'var(--color-warning, #ca8a04)' }}>
              Tree truncated — some files are not listed.
            </p>
          )}
          {dirChildren.length === 0 ? (
            <p style={{ padding: 16, color: 'var(--text-secondary, #999)' }}>This folder is empty.</p>
          ) : (
            dirChildren.map((child) => (
              <button key={child.path} type="button" onClick={() => onNavigate(child.path)} style={rowStyle}>
                {child.type === 'tree' ? (
                  <Folder size={16} style={{ color: 'var(--color-info, #2563eb)' }} />
                ) : isImageFile(child.name) ? (
                  <ImageIcon size={16} style={{ opacity: 0.7 }} />
                ) : (
                  <FileText size={16} style={{ opacity: 0.7 }} />
                )}
                <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', fontSize: 14 }}>{child.name}</span>
                {child.type === 'blob' && typeof child.size === 'number' && (
                  <span style={{ fontSize: 12, color: 'var(--text-secondary, #999)' }}>{formatFileSize(child.size)}</span>
                )}
              </button>
            ))
          )}
        </>
      )}
    </div>
  );
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '10px 12px',
  background: 'transparent',
  border: 'none',
  borderBottom: '1px solid var(--border-subtle, #2a2a2a)',
  cursor: 'pointer',
  textAlign: 'left',
  color: 'var(--text-primary, #e5e5e5)',
};
