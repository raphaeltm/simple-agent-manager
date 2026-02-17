import { type CSSProperties, type FC, useCallback, useEffect, useState } from 'react';
import { ChevronRight, Folder, FileText, RefreshCw, X } from 'lucide-react';
import { Spinner } from '@simple-agent-manager/ui';
import { getFileList, type FileEntry } from '../lib/api';

interface FileBrowserPanelProps {
  workspaceUrl: string;
  workspaceId: string;
  token: string;
  worktree?: string | null;
  initialPath?: string;
  isMobile: boolean;
  onClose: () => void;
  onSelectFile: (filePath: string) => void;
  onNavigate: (dirPath: string) => void;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

export const FileBrowserPanel: FC<FileBrowserPanelProps> = ({
  workspaceUrl,
  workspaceId,
  token,
  worktree,
  initialPath = '.',
  isMobile,
  onClose,
  onSelectFile,
  onNavigate,
}) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState(initialPath);

  const fetchListing = useCallback(
    async (dirPath: string) => {
      setLoading(true);
      setError(null);
      try {
        const result = await getFileList(
          workspaceUrl,
          workspaceId,
          token,
          dirPath,
          worktree ?? undefined
        );
        setEntries(result.entries);
        setCurrentPath(result.path);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to list directory');
      } finally {
        setLoading(false);
      }
    },
    [workspaceUrl, workspaceId, token, worktree]
  );

  useEffect(() => {
    fetchListing(initialPath);
  }, [fetchListing, initialPath]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleEntryClick = (entry: FileEntry) => {
    const fullPath = currentPath === '.' ? entry.name : `${currentPath}/${entry.name}`;
    if (entry.type === 'dir') {
      onNavigate(fullPath);
    } else {
      onSelectFile(fullPath);
    }
  };

  // Build breadcrumb segments from currentPath
  const breadcrumbs = buildBreadcrumbs(currentPath);

  const overlayStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 60,
    backgroundColor: 'var(--sam-color-bg-canvas)',
    display: 'flex',
    flexDirection: 'column',
  };

  const headerStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    padding: isMobile ? '0 8px' : '0 16px',
    height: isMobile ? 44 : 40,
    backgroundColor: 'var(--sam-color-bg-surface)',
    borderBottom: '1px solid var(--sam-color-border-default)',
    gap: isMobile ? 8 : 12,
    flexShrink: 0,
  };

  return (
    <div style={overlayStyle}>
      {/* Header */}
      <header style={headerStyle}>
        <button onClick={onClose} aria-label="Close file browser" style={iconButtonStyle(isMobile)}>
          <svg
            style={{ height: isMobile ? 18 : 16, width: isMobile ? 18 : 16 }}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
        </button>

        <span
          style={{
            fontWeight: 600,
            fontSize: '0.875rem',
            color: 'var(--sam-color-fg-primary)',
            flex: 1,
          }}
        >
          Files
        </span>

        <button
          onClick={() => fetchListing(currentPath)}
          disabled={loading}
          aria-label="Refresh file listing"
          style={{
            ...iconButtonStyle(isMobile),
            opacity: loading ? 0.5 : 1,
          }}
        >
          <RefreshCw
            size={isMobile ? 16 : 14}
            style={loading ? { animation: 'spin 1s linear infinite' } : undefined}
          />
        </button>

        <button onClick={onClose} aria-label="Close" style={iconButtonStyle(isMobile)}>
          <X size={isMobile ? 18 : 16} />
        </button>
      </header>

      {/* Breadcrumb */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: isMobile ? '8px 12px' : '6px 16px',
          gap: 2,
          overflow: 'auto',
          flexShrink: 0,
          borderBottom: '1px solid var(--sam-color-border-default)',
          backgroundColor: 'var(--sam-color-bg-surface)',
        }}
      >
        {breadcrumbs.map((crumb, idx) => (
          <span key={crumb.path} style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
            {idx > 0 && (
              <ChevronRight
                size={12}
                style={{ color: 'var(--sam-color-fg-muted)', margin: '0 2px', flexShrink: 0 }}
              />
            )}
            <button
              onClick={() => onNavigate(crumb.path)}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: isMobile ? '4px 6px' : '2px 4px',
                borderRadius: 4,
                fontFamily: 'monospace',
                fontSize: '0.75rem',
                color:
                  idx === breadcrumbs.length - 1
                    ? 'var(--sam-color-fg-primary)'
                    : 'var(--sam-color-fg-muted)',
                fontWeight: idx === breadcrumbs.length - 1 ? 600 : 400,
                whiteSpace: 'nowrap',
              }}
            >
              {crumb.label}
            </button>
          </span>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: isMobile ? '4px 0' : '4px 0' }}>
        {loading && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
            <Spinner size="md" />
          </div>
        )}

        {error && (
          <div
            style={{
              margin: 16,
              padding: 12,
              backgroundColor: 'rgba(247, 118, 142, 0.1)',
              borderRadius: 8,
              color: '#f7768e',
              fontSize: '0.8125rem',
            }}
          >
            {error}
          </div>
        )}

        {!loading && !error && entries.length === 0 && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              padding: 48,
              color: 'var(--sam-color-fg-muted)',
              fontSize: '0.875rem',
            }}
          >
            This directory is empty
          </div>
        )}

        {!loading && !error && entries.length > 0 && (
          <div>
            {entries.map((entry) => (
              <FileRow
                key={entry.name}
                entry={entry}
                onClick={() => handleEntryClick(entry)}
                isMobile={isMobile}
              />
            ))}
          </div>
        )}
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
};

// ---------- Sub-components ----------

interface FileRowProps {
  entry: FileEntry;
  onClick: () => void;
  isMobile: boolean;
}

const FileRow: FC<FileRowProps> = ({ entry, onClick, isMobile }) => {
  const [hovered, setHovered] = useState(false);
  const isDir = entry.type === 'dir';

  const rowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    padding: isMobile ? '10px 16px' : '6px 16px',
    minHeight: isMobile ? 44 : 32,
    cursor: 'pointer',
    gap: 10,
    backgroundColor: hovered ? 'var(--sam-color-bg-surface-hover)' : 'transparent',
    transition: 'background-color 0.1s',
  };

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={rowStyle}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {isDir ? (
        <Folder
          size={isMobile ? 16 : 14}
          style={{ color: 'var(--sam-color-accent-primary)', flexShrink: 0 }}
        />
      ) : (
        <FileText
          size={isMobile ? 16 : 14}
          style={{ color: 'var(--sam-color-fg-muted)', flexShrink: 0 }}
        />
      )}
      <span
        style={{
          fontFamily: 'monospace',
          fontSize: '0.8125rem',
          color: 'var(--sam-color-fg-primary)',
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
        }}
      >
        {entry.name}
        {isDir ? '/' : ''}
      </span>
      {!isDir && entry.size > 0 && (
        <span
          style={{
            fontFamily: 'monospace',
            fontSize: '0.6875rem',
            color: 'var(--sam-color-fg-muted)',
            flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
        >
          {formatSize(entry.size)}
        </span>
      )}
    </div>
  );
};

// ---------- Helpers ----------

interface BreadcrumbItem {
  label: string;
  path: string;
}

function buildBreadcrumbs(dirPath: string): BreadcrumbItem[] {
  const crumbs: BreadcrumbItem[] = [{ label: '/', path: '.' }];

  if (dirPath === '.' || dirPath === '' || dirPath === '/') {
    return crumbs;
  }

  // Remove leading ./ or /
  let normalized = dirPath;
  if (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (normalized.startsWith('/')) normalized = normalized.slice(1);

  const parts = normalized.split('/').filter(Boolean);
  let accumulated = '';

  for (const part of parts) {
    accumulated = accumulated ? `${accumulated}/${part}` : part;
    crumbs.push({ label: part, path: accumulated });
  }

  return crumbs;
}

function iconButtonStyle(isMobile: boolean): CSSProperties {
  return {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--sam-color-fg-muted)',
    padding: isMobile ? 8 : 4,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: isMobile ? 44 : 32,
    minHeight: isMobile ? 44 : 32,
    flexShrink: 0,
  };
}
