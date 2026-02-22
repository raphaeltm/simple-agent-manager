import {
  type CSSProperties,
  type FC,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from 'react';
import { X, FileText } from 'lucide-react';
import { Highlight, themes } from 'prism-react-renderer';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Spinner } from '@simple-agent-manager/ui';
import { getGitDiff, getGitFile } from '../lib/api';

interface GitDiffViewProps {
  workspaceUrl: string;
  workspaceId: string;
  token: string;
  worktree?: string | null;
  filePath: string;
  staged: boolean;
  isMobile: boolean;
  onBack: () => void;
  onClose: () => void;
  onViewInFileBrowser?: (filePath: string) => void;
}

type ViewMode = 'diff' | 'full';
type MarkdownViewMode = 'rendered' | 'source';

function isMarkdownFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.mdx');
}

export const GitDiffView: FC<GitDiffViewProps> = ({
  workspaceUrl,
  workspaceId,
  token,
  worktree,
  filePath,
  staged,
  isMobile,
  onBack,
  onClose,
  onViewInFileBrowser,
}) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState('');
  const [fullContent, setFullContent] = useState<string | null>(null);
  const [fullLoading, setFullLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('diff');
  const [markdownMode, setMarkdownMode] = useState<MarkdownViewMode>('rendered');

  const markdownFile = isMarkdownFile(filePath);

  const fetchDiff = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getGitDiff(
        workspaceUrl,
        workspaceId,
        token,
        filePath,
        staged,
        worktree ?? undefined
      );
      setDiff(result.diff);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch diff');
    } finally {
      setLoading(false);
    }
  }, [workspaceUrl, workspaceId, token, filePath, staged, worktree]);

  const fetchFullFile = useCallback(async () => {
    if (fullContent !== null) return; // already loaded
    setFullLoading(true);
    try {
      const result = await getGitFile(
        workspaceUrl,
        workspaceId,
        token,
        filePath,
        undefined,
        worktree ?? undefined
      );
      setFullContent(result.content);
    } catch {
      // Fallback: just show diff if full file fails
      setFullContent(null);
      setViewMode('diff');
    } finally {
      setFullLoading(false);
    }
  }, [workspaceUrl, workspaceId, token, filePath, fullContent, worktree]);

  useEffect(() => {
    fetchDiff();
  }, [fetchDiff]);

  useEffect(() => {
    if (viewMode === 'full') {
      fetchFullFile();
    }
  }, [viewMode, fetchFullFile]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Parse diff to get set of added line numbers (for full-file view highlighting)
  const addedLines = parseDiffAddedLines(diff);

  const overlayStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 'var(--sam-z-panel)' as unknown as number,
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
          {filePath}
        </span>

        {/* Diff / Full toggle */}
        <div
          style={{
            display: 'flex',
            borderRadius: 6,
            overflow: 'hidden',
            border: '1px solid var(--sam-color-border-default)',
            flexShrink: 0,
          }}
        >
          <ToggleButton
            label="Diff"
            active={viewMode === 'diff'}
            onClick={() => setViewMode('diff')}
          />
          <ToggleButton
            label="Full"
            active={viewMode === 'full'}
            onClick={() => setViewMode('full')}
          />
        </div>

        {/* Rendered / Source toggle for markdown files in full mode */}
        {markdownFile && viewMode === 'full' && (
          <div
            style={{
              display: 'flex',
              borderRadius: 6,
              overflow: 'hidden',
              border: '1px solid var(--sam-color-border-default)',
              flexShrink: 0,
            }}
          >
            <ToggleButton
              label="Rendered"
              active={markdownMode === 'rendered'}
              onClick={() => setMarkdownMode('rendered')}
            />
            <ToggleButton
              label="Source"
              active={markdownMode === 'source'}
              onClick={() => setMarkdownMode('source')}
            />
          </div>
        )}

        {onViewInFileBrowser && (
          <button
            onClick={() => onViewInFileBrowser(filePath)}
            aria-label="View in file browser"
            title="View in file browser"
            style={iconBtnStyle(isMobile)}
          >
            <FileText size={isMobile ? 18 : 16} />
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
              backgroundColor: 'var(--sam-color-danger-tint)',
              borderRadius: 8,
              color: 'var(--sam-color-tn-red)',
              fontSize: 'var(--sam-type-caption-size)',
            }}
          >
            {error}
          </div>
        )}

        {!loading && !error && diff === '' && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              padding: 48,
              color: 'var(--sam-color-fg-muted)',
              fontSize: 'var(--sam-type-secondary-size)',
            }}
          >
            No diff available
          </div>
        )}

        {!loading && !error && diff !== '' && viewMode === 'diff' && <DiffRenderer diff={diff} />}

        {!loading &&
          !error &&
          viewMode === 'full' &&
          (fullLoading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
              <Spinner size="md" />
            </div>
          ) : fullContent !== null ? (
            markdownFile && markdownMode === 'rendered' ? (
              <RenderedMarkdown content={fullContent} />
            ) : (
              <FullFileRenderer content={fullContent} addedLines={addedLines} />
            )
          ) : (
            <DiffRenderer diff={diff} />
          ))}
      </div>
    </div>
  );
};

// ---------- Diff Renderer ----------

const DiffRenderer: FC<{ diff: string }> = ({ diff }) => {
  const lines = diff.split('\n');

  return (
    <div style={{ fontFamily: 'monospace', fontSize: '0.8125rem' }}>
      {lines.map((line, idx) => (
        <div key={idx} style={diffLineStyle(line)}>
          {line}
        </div>
      ))}
    </div>
  );
};

function diffLineStyle(line: string): CSSProperties {
  const base: CSSProperties = {
    padding: '1px 12px',
    whiteSpace: 'pre',
    minHeight: '1.4em',
    lineHeight: '1.4',
  };

  if (line.startsWith('+') && !line.startsWith('+++')) {
    return {
      ...base,
      backgroundColor: 'var(--sam-color-success-tint)',
      color: 'var(--sam-color-tn-green)',
    };
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return {
      ...base,
      backgroundColor: 'var(--sam-color-danger-tint)',
      color: 'var(--sam-color-tn-red)',
    };
  }
  if (line.startsWith('@@')) {
    return {
      ...base,
      backgroundColor: 'var(--sam-color-info-tint)',
      color: 'var(--sam-color-tn-blue)',
    };
  }
  if (
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('---') ||
    line.startsWith('+++')
  ) {
    return {
      ...base,
      color: 'var(--sam-color-fg-muted)',
      fontWeight: 600,
    };
  }

  return {
    ...base,
    color: 'var(--sam-color-fg-muted)',
  };
}

// ---------- Full File Renderer ----------

const FullFileRenderer: FC<{ content: string; addedLines: Set<number> }> = ({
  content,
  addedLines,
}) => {
  const lines = content.split('\n');

  return (
    <div style={{ fontFamily: 'monospace', fontSize: '0.8125rem' }}>
      {lines.map((line, idx) => {
        const lineNum = idx + 1;
        const isAdded = addedLines.has(lineNum);

        return (
          <div
            key={idx}
            style={{
              display: 'flex',
              padding: '1px 0',
              whiteSpace: 'pre',
              minHeight: '1.4em',
              lineHeight: '1.4',
              backgroundColor: isAdded ? 'var(--sam-color-success-tint)' : 'transparent',
            }}
          >
            <span
              style={{
                display: 'inline-block',
                width: 48,
                textAlign: 'right',
                paddingRight: 12,
                color: isAdded ? 'var(--sam-color-tn-green)' : 'var(--sam-color-fg-muted)',
                opacity: isAdded ? 1 : 0.5,
                userSelect: 'none',
                flexShrink: 0,
              }}
            >
              {lineNum}
            </span>
            <span
              style={{
                color: isAdded ? 'var(--sam-color-tn-green)' : 'var(--sam-color-fg-primary)',
                flex: 1,
              }}
            >
              {line}
            </span>
          </div>
        );
      })}
    </div>
  );
};

// ---------- Toggle Button ----------

const ToggleButton: FC<{ label: string; active: boolean; onClick: () => void }> = ({
  label,
  active,
  onClick,
}) => (
  <button
    onClick={onClick}
    style={{
      padding: '3px 10px',
      fontSize: '0.6875rem',
      fontWeight: 600,
      border: 'none',
      cursor: 'pointer',
      backgroundColor: active ? 'var(--sam-color-accent-primary)' : 'transparent',
      color: active ? 'var(--sam-color-fg-on-accent)' : 'var(--sam-color-fg-muted)',
      transition: 'background-color 0.15s, color 0.15s',
    }}
  >
    {label}
  </button>
);

// ---------- Rendered Markdown ----------

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
    <div style={markdownContainerStyle}>
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
                backgroundColor: 'var(--sam-color-info-tint)',
              }}
            >
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" style={{ color: 'var(--sam-color-tn-blue)' }}>
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div style={{ overflowX: 'auto', marginBottom: 12 }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 320 }}>
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th style={{ border: '1px solid var(--sam-color-border-default)', padding: '6px 8px', textAlign: 'left', backgroundColor: 'var(--sam-color-info-tint)' }}>
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
                  <Highlight theme={themes.nightOwl} code={code} language={match[1] ?? ''}>
                    {({ tokens, getLineProps, getTokenProps }) => (
                      <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: '0.8125rem', lineHeight: '1.5', background: 'transparent' }}>
                        {tokens.map((line, lineIdx) => {
                          const lineProps = getLineProps({ line });
                          return (
                            <div key={lineIdx} {...lineProps} style={{ ...lineProps.style, whiteSpace: 'pre', minHeight: '1.5em' }}>
                              {line.map((token, tokenIdx) => {
                                const tokenProps = getTokenProps({ token });
                                return <span key={tokenIdx} {...tokenProps} />;
                              })}
                            </div>
                          );
                        })}
                      </pre>
                    )}
                  </Highlight>
                </div>
              );
            }

            return (
              <code
                {...props}
                style={{
                  backgroundColor: 'var(--sam-color-info-tint)',
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

// ---------- Helpers ----------

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

/**
 * Parse a unified diff to extract which line numbers in the new file are additions.
 * Returns a Set of 1-based line numbers.
 */
function parseDiffAddedLines(diff: string): Set<number> {
  const added = new Set<number>();
  if (!diff) return added;

  let currentLine = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      // Parse hunk header: @@ -old,count +new,count @@
      const match = line.match(/\+(\d+)/);
      if (match?.[1]) {
        currentLine = parseInt(match[1], 10);
      }
      continue;
    }
    if (currentLine === 0) continue; // before first hunk

    if (line.startsWith('+') && !line.startsWith('+++')) {
      added.add(currentLine);
      currentLine++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // Removed lines don't advance the new-file line counter
    } else {
      // Context line
      currentLine++;
    }
  }

  return added;
}
