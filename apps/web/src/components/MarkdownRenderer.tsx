import {
  type CSSProperties,
  type FC,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { Highlight, themes } from 'prism-react-renderer';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// ---------- Syntax Highlighted Code ----------

export const SyntaxHighlightedCode: FC<{ content: string; language: string }> = ({
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

export const RenderedMarkdown: FC<{ content: string; style?: CSSProperties }> = ({ content, style }) => {
  return (
    <div style={{ ...markdownContainerStyle, ...style }} data-testid="rendered-markdown">
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
                backgroundColor: 'var(--sam-color-info-tint)',
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
