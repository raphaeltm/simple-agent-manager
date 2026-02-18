import { type CSSProperties, type FC, useCallback, useEffect, useState } from 'react';
import { ChevronDown, RefreshCw, X } from 'lucide-react';
import { Spinner } from '@simple-agent-manager/ui';
import { getGitStatus, type GitFileStatus, type GitStatusData } from '../lib/api';

interface GitChangesPanelProps {
  workspaceUrl: string;
  workspaceId: string;
  token: string;
  worktree?: string | null;
  isMobile: boolean;
  onClose: () => void;
  onSelectFile: (filePath: string, staged: boolean) => void;
  onStatusChange?: (status: GitStatusData) => void;
  onStatusFetchError?: () => void;
}

const STATUS_LABELS: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  U: 'Unmerged',
  '??': 'Untracked',
};

const STATUS_COLORS: Record<string, string> = {
  M: '#e0af68', // yellow
  A: '#9ece6a', // green
  D: '#f7768e', // red
  R: '#7aa2f7', // blue
  C: '#7aa2f7', // blue
  U: '#ff9e64', // orange
  '??': '#787c99', // grey
};

function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? 'var(--sam-color-fg-muted)';
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export const GitChangesPanel: FC<GitChangesPanelProps> = ({
  workspaceUrl,
  workspaceId,
  token,
  worktree,
  isMobile,
  onClose,
  onSelectFile,
  onStatusChange,
  onStatusFetchError,
}) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<GitStatusData | null>(null);
  const [expandedSections, setExpandedSections] = useState({
    staged: true,
    unstaged: true,
    untracked: true,
  });

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getGitStatus(workspaceUrl, workspaceId, token, worktree ?? undefined);
      setData(result);
      onStatusChange?.(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch git status');
      onStatusFetchError?.();
    } finally {
      setLoading(false);
    }
  }, [workspaceUrl, workspaceId, token, worktree, onStatusChange, onStatusFetchError]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const toggleSection = (section: 'staged' | 'unstaged' | 'untracked') => {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  const totalChanges = data ? data.staged.length + data.unstaged.length + data.untracked.length : 0;

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
        <button onClick={onClose} aria-label="Close git changes" style={iconButtonStyle(isMobile)}>
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
          Git Changes
          {data && !loading && (
            <span style={{ color: 'var(--sam-color-fg-muted)', fontWeight: 400, marginLeft: 6 }}>
              ({totalChanges})
            </span>
          )}
        </span>

        <button
          onClick={fetchStatus}
          disabled={loading}
          aria-label="Refresh git status"
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

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: isMobile ? '8px 0' : '8px 0' }}>
        {loading && !data && (
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

        {data && !loading && totalChanges === 0 && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 48,
              color: 'var(--sam-color-fg-muted)',
              fontSize: '0.875rem',
            }}
          >
            <span style={{ fontSize: '1.5rem', marginBottom: 8 }}>Clean</span>
            <span>No changes detected</span>
          </div>
        )}

        {data && data.staged.length > 0 && (
          <FileSection
            title="Staged"
            count={data.staged.length}
            expanded={expandedSections.staged}
            onToggle={() => toggleSection('staged')}
            files={data.staged}
            onSelectFile={(path) => onSelectFile(path, true)}
            isMobile={isMobile}
          />
        )}

        {data && data.unstaged.length > 0 && (
          <FileSection
            title="Unstaged"
            count={data.unstaged.length}
            expanded={expandedSections.unstaged}
            onToggle={() => toggleSection('unstaged')}
            files={data.unstaged}
            onSelectFile={(path) => onSelectFile(path, false)}
            isMobile={isMobile}
          />
        )}

        {data && data.untracked.length > 0 && (
          <FileSection
            title="Untracked"
            count={data.untracked.length}
            expanded={expandedSections.untracked}
            onToggle={() => toggleSection('untracked')}
            files={data.untracked}
            onSelectFile={(path) => onSelectFile(path, false)}
            isMobile={isMobile}
          />
        )}
      </div>

      {/* Inline keyframe for spinner */}
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
};

// ---------- Sub-components ----------

interface FileSectionProps {
  title: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  files: GitFileStatus[];
  onSelectFile: (path: string) => void;
  isMobile: boolean;
}

const FileSection: FC<FileSectionProps> = ({
  title,
  count,
  expanded,
  onToggle,
  files,
  onSelectFile,
  isMobile,
}) => {
  const sectionHeaderStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    padding: isMobile ? '10px 16px' : '8px 16px',
    cursor: 'pointer',
    userSelect: 'none',
    gap: 8,
    borderBottom: '1px solid var(--sam-color-border-default)',
  };

  return (
    <div>
      <div
        onClick={onToggle}
        style={sectionHeaderStyle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <ChevronDown
          size={14}
          style={{
            color: 'var(--sam-color-fg-muted)',
            transition: 'transform 0.15s',
            transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontWeight: 600,
            fontSize: '0.75rem',
            color: 'var(--sam-color-fg-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          {title}
        </span>
        <span
          style={{
            fontSize: '0.6875rem',
            color: 'var(--sam-color-fg-muted)',
            backgroundColor: 'var(--sam-color-bg-surface)',
            borderRadius: 10,
            padding: '1px 8px',
            fontWeight: 600,
          }}
        >
          {count}
        </span>
      </div>

      {expanded && (
        <div>
          {files.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              onClick={() => onSelectFile(file.path)}
              isMobile={isMobile}
            />
          ))}
        </div>
      )}
    </div>
  );
};

interface FileRowProps {
  file: GitFileStatus;
  onClick: () => void;
  isMobile: boolean;
}

const FileRow: FC<FileRowProps> = ({ file, onClick, isMobile }) => {
  const [hovered, setHovered] = useState(false);

  // Split path into directory and filename
  const lastSlash = file.path.lastIndexOf('/');
  const dir = lastSlash >= 0 ? file.path.slice(0, lastSlash + 1) : '';
  const name = lastSlash >= 0 ? file.path.slice(lastSlash + 1) : file.path;

  const rowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    padding: isMobile ? '10px 16px 10px 32px' : '6px 16px 6px 32px',
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
      <span
        style={{
          fontFamily: 'monospace',
          fontSize: '0.6875rem',
          fontWeight: 700,
          color: statusColor(file.status),
          minWidth: 20,
          textAlign: 'center',
          flexShrink: 0,
        }}
        title={statusLabel(file.status)}
      >
        {file.status}
      </span>
      <span
        style={{
          fontFamily: 'monospace',
          fontSize: '0.8125rem',
          color: 'var(--sam-color-fg-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
        }}
      >
        {dir && <span style={{ color: 'var(--sam-color-fg-muted)' }}>{dir}</span>}
        {name}
      </span>
      {file.oldPath && (
        <span
          style={{
            fontFamily: 'monospace',
            fontSize: '0.6875rem',
            color: 'var(--sam-color-fg-muted)',
            whiteSpace: 'nowrap',
          }}
        >
          (from {file.oldPath})
        </span>
      )}
    </div>
  );
};

// ---------- Shared styles ----------

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
