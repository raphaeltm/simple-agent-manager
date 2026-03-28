import {
  type CSSProperties,
  type FC,
  useCallback,
  useEffect,
  useState,
} from 'react';
import { X } from 'lucide-react';
import { Spinner } from '@simple-agent-manager/ui';
import { getGitFile, getFileRawUrl } from '../lib/api';
import { isImageFile } from '../lib/file-utils';
import { SyntaxHighlightedCode, RenderedMarkdown } from './MarkdownRenderer';
import { ImageViewer } from './shared-file-viewer';

interface FileViewerPanelProps {
  workspaceUrl: string;
  workspaceId: string;
  token: string;
  worktree?: string | null;
  filePath: string;
  isMobile: boolean;
  /** If the file has git changes, show a "View Diff" button */
  hasGitChanges?: boolean;
  /** Whether this file is staged (needed for the diff link) */
  isStaged?: boolean;
  onBack: () => void;
  onClose: () => void;
  onViewDiff?: (filePath: string, staged: boolean) => void;
}

// Map file extensions to Prism language identifiers
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  go: 'go',
  py: 'python',
  css: 'css',
  html: 'markup',
  htm: 'markup',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  dockerfile: 'docker',
  toml: 'toml',
  sql: 'sql',
  rs: 'rust',
  rb: 'ruby',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  xml: 'markup',
  svg: 'markup',
  graphql: 'graphql',
  gql: 'graphql',
};

function detectLanguage(filePath: string): string {
  const filename = filePath.split('/').pop() ?? '';
  const lower = filename.toLowerCase();

  // Special filenames
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'docker';
  if (lower === 'makefile') return 'makefile';

  const ext = lower.split('.').pop() ?? '';
  return EXT_TO_LANG[ext] ?? '';
}

function isBinaryContent(content: string): boolean {
  // Check for null bytes (strong indicator of binary)
  return content.includes('\0');
}

type MarkdownViewMode = 'rendered' | 'source';

const MARKDOWN_MODE_STORAGE_KEY = 'sam:md-render-mode';

function isMarkdownFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.mdx');
}

function readMarkdownViewMode(): MarkdownViewMode {
  if (typeof window === 'undefined') return 'rendered';
  const stored = window.localStorage.getItem(MARKDOWN_MODE_STORAGE_KEY);
  return stored === 'source' ? 'source' : 'rendered';
}

export const FileViewerPanel: FC<FileViewerPanelProps> = ({
  workspaceUrl,
  workspaceId,
  token,
  worktree,
  filePath,
  isMobile,
  hasGitChanges,
  isStaged,
  onBack,
  onClose,
  onViewDiff,
}) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [markdownMode, setMarkdownMode] = useState<MarkdownViewMode>(() => readMarkdownViewMode());

  const imageFile = isImageFile(filePath);

  const fetchFile = useCallback(async () => {
    // Image files are rendered via <img src> — no text content fetch needed
    if (imageFile) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await getGitFile(
        workspaceUrl,
        workspaceId,
        token,
        filePath,
        undefined,
        worktree ?? undefined
      );
      setContent(result.content);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load file');
    } finally {
      setLoading(false);
    }
  }, [workspaceUrl, workspaceId, token, filePath, worktree, imageFile]);

  useEffect(() => {
    fetchFile();
  }, [fetchFile]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    window.localStorage.setItem(MARKDOWN_MODE_STORAGE_KEY, markdownMode);
  }, [markdownMode]);

  const fileName = filePath.split('/').pop() ?? filePath;
  const markdownFile = isMarkdownFile(filePath);
  const language = detectLanguage(filePath);
  const binary = content !== null && isBinaryContent(content);

  return (
    <div className="fixed inset-0 z-panel bg-canvas flex flex-col">
      {/* Header */}
      <header
        className="flex items-center bg-surface border-b border-border-default shrink-0"
        style={{
          padding: isMobile ? '0 8px' : '0 16px',
          height: isMobile ? 44 : 40,
          gap: isMobile ? 6 : 12,
        }}
      >
        <button onClick={onBack} aria-label="Back to file list" style={iconBtnStyle(isMobile)}>
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
            fontFamily: 'monospace',
            fontSize: isMobile ? '0.75rem' : '0.8125rem',
            color: 'var(--sam-color-fg-primary)',
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}
        >
          {fileName}
        </span>

        {markdownFile && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              border: '1px solid var(--sam-color-border-default)',
              borderRadius: 6,
              overflow: 'hidden',
              flexShrink: 0,
            }}
          >
            <button
              onClick={() => setMarkdownMode('rendered')}
              aria-label="Show rendered markdown"
              style={markdownModeButtonStyle(markdownMode === 'rendered')}
            >
              Rendered
            </button>
            <button
              onClick={() => setMarkdownMode('source')}
              aria-label="Show markdown source"
              style={markdownModeButtonStyle(markdownMode === 'source')}
            >
              Source
            </button>
          </div>
        )}

        {hasGitChanges && onViewDiff && (
          <button
            onClick={() => onViewDiff(filePath, isStaged ?? false)}
            style={{
              padding: '3px 10px',
              fontSize: '0.6875rem',
              fontWeight: 600,
              border: '1px solid var(--sam-color-border-default)',
              borderRadius: 6,
              cursor: 'pointer',
              backgroundColor: 'transparent',
              color: 'var(--sam-color-fg-primary)',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            View Diff
          </button>
        )}

        <button onClick={onClose} aria-label="Close" style={iconBtnStyle(isMobile)}>
          <X size={isMobile ? 18 : 16} />
        </button>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {imageFile ? (
          <ImageViewer
            src={getFileRawUrl(workspaceUrl, workspaceId, token, filePath, worktree ?? undefined)}
            fileName={fileName}
          />
        ) : (
          <div className="flex-1 overflow-auto">
            {loading && (
              <div className="flex justify-center p-8">
                <Spinner size="md" />
              </div>
            )}

            {error && (
              <div
                className="m-4 p-3 bg-danger-tint rounded-lg text-tn-red"
                style={{ fontSize: 'var(--sam-type-caption-size)' }}
              >
                {error}
              </div>
            )}

            {!loading && !error && binary && (
              <div
                className="flex justify-center p-12 text-fg-muted"
                style={{ fontSize: 'var(--sam-type-secondary-size)' }}
              >
                Binary file — cannot display
              </div>
            )}

            {!loading && !error && content !== null && !binary && (
              markdownFile && markdownMode === 'rendered' ? (
                <RenderedMarkdown content={content} />
              ) : (
                <SyntaxHighlightedCode content={content} language={language} />
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// ---------- Shared styles ----------

function iconBtnStyle(isMobile: boolean): CSSProperties {
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

function markdownModeButtonStyle(active: boolean): CSSProperties {
  return {
    border: 'none',
    backgroundColor: active ? 'var(--sam-color-info-tint)' : 'transparent',
    color: active ? 'var(--sam-color-fg-primary)' : 'var(--sam-color-fg-muted)',
    fontSize: '0.6875rem',
    fontWeight: 600,
    padding: '4px 8px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };
}
