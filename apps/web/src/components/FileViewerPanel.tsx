import {
  type CSSProperties,
  type FC,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from 'react';
import { X } from 'lucide-react';
import { Highlight, themes } from 'prism-react-renderer';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Spinner } from '@simple-agent-manager/ui';
import { getGitFile } from '../lib/api';

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

  const fetchFile = useCallback(async () => {
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
  }, [workspaceUrl, workspaceId, token, filePath, worktree]);

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
    gap: isMobile ? 6 : 12,
    flexShrink: 0,
  };

  return (
    <div style={overlayStyle}>
      {/* Header */}
      <header style={headerStyle}>
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
      <div style={{ flex: 1, overflow: 'auto' }}>
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
              fontSize: 'var(--sam-type-caption-size)',
            }}
          >
            {error}
          </div>
        )}

        {!loading && !error && binary && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              padding: 48,
              color: 'var(--sam-color-fg-muted)',
              fontSize: 'var(--sam-type-secondary-size)',
            }}
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
    </div>
  );
};

// ---------- Syntax Highlighted Code ----------

const SyntaxHighlightedCode: FC<{ content: string; language: string }> = ({
  content,
  language,
}) => {
  return (
    <Highlight theme={themes.nightOwl} code={content} language={language || 'text'}>
      {({ tokens, getLineProps, getTokenProps }) => (
        <pre
          style={{
            margin: 0,
            padding: 0,
            fontFamily: 'monospace',
            fontSize: '0.8125rem',
            lineHeight: '1.5',
            background: 'transparent',
            overflow: 'visible',
          }}
        >
          {tokens.map((line, lineIdx) => {
            const lineProps = getLineProps({ line });
            return (
              <div
                key={lineIdx}
                {...lineProps}
                style={{
                  ...lineProps.style,
                  display: 'flex',
                  padding: 0,
                  whiteSpace: 'pre',
                  minHeight: '1.5em',
                }}
              >
                <span
                  style={{
                    display: 'inline-block',
                    width: 48,
                    textAlign: 'right',
                    paddingRight: 12,
                    color: 'var(--sam-color-fg-muted)',
                    opacity: 0.5,
                    userSelect: 'none',
                    flexShrink: 0,
                  }}
                >
                  {lineIdx + 1}
                </span>
                <span style={{ flex: 1 }}>
                  {line.map((token, tokenIdx) => {
                    const tokenProps = getTokenProps({ token });
                    return <span key={tokenIdx} {...tokenProps} />;
                  })}
                </span>
              </div>
            );
          })}
        </pre>
      )}
    </Highlight>
  );
};

// ---------- Markdown Rendering ----------

const markdownContainerStyle: CSSProperties = {
  maxWidth: '100%',
  overflowX: 'hidden',
  padding: '16px',
  color: 'var(--sam-color-fg-primary)',
  lineHeight: 1.6,
  fontSize: 'var(--sam-type-body-size)',
  wordBreak: 'break-word',
};

const RenderedMarkdown: FC<{ content: string }> = ({ content }) => {
  return (
    <div style={markdownContainerStyle} data-testid="rendered-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 style={{ fontSize: 'var(--sam-type-page-title-size)', margin: '0 0 12px', lineHeight: 1.25 }}>{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 style={{ fontSize: 'var(--sam-type-page-title-size)', margin: '18px 0 10px', lineHeight: 1.3 }}>{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 style={{ fontSize: 'var(--sam-type-section-heading-size)', margin: '16px 0 8px', lineHeight: 1.35 }}>{children}</h3>
          ),
          p: ({ children }) => <p style={{ margin: '0 0 12px' }}>{children}</p>,
          ul: ({ children }) => <ul style={{ margin: '0 0 12px', paddingLeft: 22 }}>{children}</ul>,
          ol: ({ children }) => <ol style={{ margin: '0 0 12px', paddingLeft: 22 }}>{children}</ol>,
          li: ({ children }) => <li style={{ marginBottom: 4 }}>{children}</li>,
          blockquote: ({ children }) => (
            <blockquote
              style={{
                margin: '12px 0',
                padding: '8px 12px',
                borderLeft: '3px solid var(--sam-color-border-default)',
                backgroundColor: 'rgba(122, 162, 247, 0.08)',
              }}
            >
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" style={{ color: '#7aa2f7' }}>
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div style={{ overflowX: 'auto', marginBottom: 12 }}>
              <table
                style={{
                  borderCollapse: 'collapse',
                  width: '100%',
                  minWidth: 320,
                }}
              >
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th
              style={{
                border: '1px solid var(--sam-color-border-default)',
                padding: '6px 8px',
                textAlign: 'left',
                backgroundColor: 'rgba(122, 162, 247, 0.08)',
              }}
            >
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td style={{ border: '1px solid var(--sam-color-border-default)', padding: '6px 8px' }}>
              {children}
            </td>
          ),
          code: ({
            className,
            children,
            ...props
          }: HTMLAttributes<HTMLElement> & { children?: ReactNode }) => {
            const match = /language-(\w+)/.exec(className ?? '');
            const code = String(children ?? '').replace(/\n$/, '');

            if (match) {
              return (
                <div style={{ marginBottom: 12 }}>
                  <SyntaxHighlightedCode content={code} language={match[1] ?? ''} />
                </div>
              );
            }

            return (
              <code
                {...props}
                style={{
                  backgroundColor: 'rgba(122, 162, 247, 0.12)',
                  borderRadius: 4,
                  padding: '1px 5px',
                  fontFamily: 'monospace',
                  fontSize: '0.85em',
                }}
              >
                {children}
              </code>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
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
    backgroundColor: active ? 'rgba(122, 162, 247, 0.2)' : 'transparent',
    color: active ? 'var(--sam-color-fg-primary)' : 'var(--sam-color-fg-muted)',
    fontSize: '0.6875rem',
    fontWeight: 600,
    padding: '4px 8px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };
}
