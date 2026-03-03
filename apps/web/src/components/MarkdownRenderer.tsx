import {
  type CSSProperties,
  type FC,
  type HTMLAttributes,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Highlight, themes } from 'prism-react-renderer';
import mermaid from 'mermaid';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// ---------- Mermaid Initialization ----------

let mermaidInitialized = false;

function ensureMermaidInit() {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    themeVariables: {
      darkMode: true,
      background: '#13201d',
      primaryColor: '#1a3a32',
      primaryTextColor: '#e6f2ee',
      primaryBorderColor: '#29423b',
      secondaryColor: '#1a2e3a',
      tertiaryColor: '#2a1a3a',
      lineColor: '#9fb7ae',
      textColor: '#e6f2ee',
      mainBkg: '#1a3a32',
      nodeBorder: '#29423b',
      clusterBkg: '#13201d',
      clusterBorder: '#29423b',
      titleColor: '#e6f2ee',
      edgeLabelBackground: '#13201d',
      nodeTextColor: '#e6f2ee',
    },
    fontFamily: 'monospace',
    securityLevel: 'loose',
    logLevel: 5,
  });
  mermaidInitialized = true;
}

// ---------- Mermaid Diagram Component ----------

let mermaidCounter = 0;

const MermaidDiagram: FC<{ code: string }> = ({ code }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(`mermaid-${Date.now()}-${++mermaidCounter}`);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const diagramId = idRef.current;

    async function render() {
      ensureMermaidInit();
      try {
        const { svg } = await mermaid.render(diagramId, code);
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to render diagram');
        }
      }
    }

    render();
    return () => {
      cancelled = true;
      // Clean up mermaid's temp element if it was left in the DOM
      document.getElementById(diagramId)?.remove();
      document.getElementById('d' + diagramId)?.remove();
    };
  }, [code]);

  if (error) {
    return (
      <div
        data-testid="mermaid-diagram"
        className="mb-3 px-4 py-3 bg-danger-tint border border-border-default rounded-md font-mono text-fg-muted whitespace-pre-wrap"
        style={{ fontSize: '0.8125rem' }}
      >
        <div className="mb-2 text-fg-primary">
          Mermaid diagram error
        </div>
        {error}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-testid="mermaid-diagram"
      className="mb-3 overflow-auto"
    />
  );
};

// ---------- Syntax Highlighted Code ----------

export const SyntaxHighlightedCode: FC<{ content: string; language: string }> = ({
  content,
  language,
}) => {
  return (
    <Highlight theme={themes.nightOwl} code={content} language={language || 'text'}>
      {({ tokens, getLineProps, getTokenProps }) => (
        <pre className="m-0 p-0 font-mono bg-transparent overflow-visible" style={{ fontSize: '0.8125rem', lineHeight: '1.5' }}>
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
                <span className="inline-block w-12 text-right pr-3 text-fg-muted opacity-50 select-none shrink-0">
                  {lineIdx + 1}
                </span>
                <span className="flex-1">
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

export const RenderedMarkdown: FC<{ content: string; style?: CSSProperties; inline?: boolean }> = ({ content, style, inline }) => {
  return (
    <div
      className={inline
        ? 'text-fg-primary leading-relaxed text-base break-words overflow-x-hidden'
        : 'max-w-[900px] mx-auto overflow-x-hidden p-4 text-fg-primary leading-relaxed text-base break-words'}
      style={style}
      data-testid="rendered-markdown"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="text-2xl mb-3 leading-tight" style={{ margin: '0 0 12px' }}>{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-2xl leading-snug" style={{ margin: '18px 0 10px' }}>{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-base leading-snug" style={{ margin: '16px 0 8px' }}>{children}</h3>
          ),
          p: ({ children }) => <p className="mb-3" style={{ margin: '0 0 12px' }}>{children}</p>,
          ul: ({ children }) => <ul className="mb-3" style={{ margin: '0 0 12px', paddingLeft: 22 }}>{children}</ul>,
          ol: ({ children }) => <ol className="mb-3" style={{ margin: '0 0 12px', paddingLeft: 22 }}>{children}</ol>,
          li: ({ children }) => <li className="mb-1">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-3 py-2 px-3 border-l-[3px] border-border-default bg-info-tint">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-tn-blue">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto mb-3">
              <table className="border-collapse w-full min-w-80">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-border-default px-2 py-1.5 text-left bg-info-tint">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-border-default px-2 py-1.5">
              {children}
            </td>
          ),
          // react-markdown wraps fenced code in <pre><code>. Our `code` override
          // replaces <code class="language-mermaid"> with <MermaidDiagram>,
          // producing <pre><MermaidDiagram/></pre>. The <pre> applies monospace
          // font and whitespace rules that break SVG layout. Unwrap it.
          // We detect mermaid by inspecting the HAST node's code child className.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          pre: ({ node, children }: { node?: any; children?: ReactNode }) => {
            const codeChild = node?.children?.find((c: any) => c.tagName === 'code');
            if (codeChild?.properties?.className?.includes('language-mermaid')) {
              return <>{children}</>;
            }
            return <pre className="m-0">{children}</pre>;
          },
          code: ({
            className,
            children,
            ...props
          }: HTMLAttributes<HTMLElement> & { children?: ReactNode }) => {
            const match = /language-(\w+)/.exec(className ?? '');
            const code = String(children ?? '').replace(/\n$/, '');

            if (match) {
              if (match[1] === 'mermaid') {
                return <MermaidDiagram code={code} />;
              }

              return (
                <div className="mb-3">
                  <SyntaxHighlightedCode content={code} language={match[1] ?? ''} />
                </div>
              );
            }

            return (
              <code
                {...props}
                className="bg-info-tint rounded-sm font-mono"
                style={{ padding: '1px 5px', fontSize: '0.85em' }}
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
