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
    <div className="flex flex-wrap items-center gap-0.5 text-[13px] px-3 py-2">
      <button
        type="button"
        onClick={() => onNavigate('')}
        className="bg-transparent border-none p-0 text-accent underline cursor-pointer text-[13px]"
      >
        /
      </button>
      {parts.map((part, i) => {
        acc = acc ? `${acc}/${part}` : part;
        const target = acc;
        const isLast = i === parts.length - 1;
        return (
          <span key={target} className="inline-flex items-center gap-0.5 min-w-0">
            <ChevronRight size={12} className="text-fg-muted" />
            <button
              type="button"
              onClick={() => onNavigate(target)}
              disabled={isLast}
              className={`bg-transparent border-none p-0 cursor-pointer text-[13px] break-all
                ${isLast ? 'text-fg-primary font-medium' : 'text-accent underline'}`}
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
      <div className="flex justify-center p-10">
        <Spinner />
      </div>
    );
  }
  if (error) {
    return <p role="alert" className="p-4 text-danger-fg">{error}</p>;
  }
  if (!file) return null;

  if (file.content !== null) {
    if (isMarkdownPath(path) && !showRawMarkdown) {
      return (
        <div className="p-3">
          <button
            type="button"
            className="bg-transparent border-none p-0 text-accent underline cursor-pointer text-xs mb-2"
            onClick={() => setShowRawMarkdown(true)}
          >
            View source
          </button>
          <RenderedMarkdown content={file.content} />
        </div>
      );
    }
    return (
      <div className="p-3">
        {isMarkdownPath(path) && (
          <button
            type="button"
            className="bg-transparent border-none p-0 text-accent underline cursor-pointer text-xs mb-2"
            onClick={() => setShowRawMarkdown(false)}
          >
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
    <div className="text-center p-10 text-fg-muted">
      <FileIcon size={28} className="opacity-50 mx-auto" />
      <p className="mt-2">
        {file.tooLarge ? 'File is too large to display inline' : 'Binary file'} ({formatFileSize(file.size)})
      </p>
      <a href={raw} download className="inline-flex items-center gap-1.5 mt-2 text-accent underline">
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
    setQuery(''); // reset stale search when switching branch
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

  const entries = useMemo(() => tree?.entries ?? [], [tree]);
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
      <div className="flex justify-center p-10">
        <Spinner />
      </div>
    );
  }
  if (error) {
    return <p role="alert" className="p-4 text-danger-fg">{error}</p>;
  }
  if (entries.length === 0) {
    return <p className="p-6 text-center text-fg-muted">This repository is empty.</p>;
  }

  return (
    <div>
      {/* Search bar */}
      <div className="px-3 py-2 border-b border-border-default">
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-inset">
          <Search size={14} className="text-fg-muted shrink-0" />
          <input
            type="search"
            placeholder="Search files by name..."
            aria-label="Search files by name"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 min-w-0 bg-transparent border-none text-fg-primary text-sm outline-none placeholder:text-fg-muted"
          />
        </div>
      </div>

      {query.trim() ? (
        <div>
          {searchResults.length === 0 ? (
            <p className="p-4 text-fg-muted text-sm">No files match &ldquo;{query}&rdquo;.</p>
          ) : (
            searchResults.map((r) => (
              <button
                key={r.path}
                type="button"
                onClick={() => {
                  setQuery('');
                  onNavigate(r.path);
                }}
                className="w-full flex items-center gap-2 px-3 py-2.5 min-h-[44px] bg-transparent border-none border-b border-border-default text-left cursor-pointer text-fg-primary hover:bg-surface-hover transition-colors"
              >
                <FileText size={14} className="text-fg-muted shrink-0" />
                <span className="break-all text-[13px]">{r.path}</span>
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
            <p className="px-3 py-1 text-xs text-warning-fg">
              Tree truncated — some files are not listed.
            </p>
          )}
          {dirChildren.length === 0 ? (
            <p className="p-4 text-fg-muted text-sm">This folder is empty.</p>
          ) : (
            dirChildren.map((child) => (
              <button
                key={child.path}
                type="button"
                onClick={() => onNavigate(child.path)}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 min-h-[44px] bg-transparent border-none border-b border-border-default text-left cursor-pointer text-fg-primary hover:bg-surface-hover transition-colors"
              >
                {child.type === 'tree' ? (
                  <Folder size={16} className="shrink-0 text-accent" />
                ) : isImageFile(child.name) ? (
                  <ImageIcon size={16} className="shrink-0 text-info" />
                ) : (
                  <FileText size={16} className="shrink-0 text-fg-muted" />
                )}
                <span className="flex-1 min-w-0 break-all text-sm">{child.name}</span>
                {child.type === 'blob' && typeof child.size === 'number' && (
                  <span className="text-xs text-fg-muted shrink-0 tabular-nums">{formatFileSize(child.size)}</span>
                )}
              </button>
            ))
          )}
        </>
      )}
    </div>
  );
};
