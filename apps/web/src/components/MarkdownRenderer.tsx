import { MERMAID_SVG_SANITIZE_CONFIG as SVG_SANITIZE_CONFIG } from '@simple-agent-manager/acp-client/mermaid';
import { Spinner } from '@simple-agent-manager/ui';
import { Highlight, themes } from 'prism-react-renderer';
import {
  type CSSProperties,
  type FC,
  type HTMLAttributes,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import ReactMarkdown, { type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { importWithRetry } from '../lib/lazy-with-retry';

const SAFE_MARKDOWN_URL_PROTOCOLS = new Set(['http:', 'https:']);

function sanitizeMarkdownHref(href: string | undefined): string {
  if (!href) return '#';
  const trimmed = href.trim();
  if (!trimmed) return '#';
  if (
    trimmed.startsWith('#') ||
    (trimmed.startsWith('/') && !trimmed.startsWith('//')) ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../')
  ) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    return SAFE_MARKDOWN_URL_PROTOCOLS.has(parsed.protocol) ? trimmed : '#';
  } catch {
    return '#';
  }
}

export { MERMAID_SVG_SANITIZE_CONFIG as SVG_SANITIZE_CONFIG } from '@simple-agent-manager/acp-client/mermaid';

// ---------- Mermaid Initialization ----------

/**
 * Mermaid (~1 MB parsed, plus DOMPurify) is loaded on demand.
 *
 * It used to be a static import at module scope, which put the whole diagram engine in
 * the initial bundle for every user on the chat path even though diagrams are rare. It
 * is now pulled in only when a ```mermaid fence is actually rendered.
 *
 * The promise is memoised so concurrent diagrams share one fetch and `initialize()`
 * runs exactly once, and is cleared on failure so a transient network error can retry.
 */
type MermaidApi = (typeof import('mermaid'))['default'];
type DomPurifyApi = (typeof import('dompurify'))['default'];

interface MermaidBundle {
  mermaid: MermaidApi;
  domPurify: DomPurifyApi;
}

let mermaidBundlePromise: Promise<MermaidBundle> | null = null;

function loadMermaid(): Promise<MermaidBundle> {
  // Routed through `importWithRetry` for the same reason route chunks are: these are
  // content-hashed chunks fetched long after the page loaded, so a redeploy mid-session
  // makes them 404. Without it a stale session would render the raw browser fetch-error
  // string inline in the chat transcript instead of recovering.
  mermaidBundlePromise ??= Promise.all([
    importWithRetry(() => import('mermaid')),
    importWithRetry(() => import('dompurify')),
  ])
    .then(([mermaidModule, domPurifyModule]) => {
      const mermaid = mermaidModule.default;
      initializeMermaid(mermaid);
      return { mermaid, domPurify: domPurifyModule.default };
    })
    .catch((error: unknown) => {
      mermaidBundlePromise = null;
      throw error;
    });
  return mermaidBundlePromise;
}

/** Exported for tests: forget the memoised module so a fresh load can be observed. */
export function resetMermaidLoaderForTests() {
  mermaidBundlePromise = null;
}

function initializeMermaid(mermaid: MermaidApi) {
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
    securityLevel: 'strict',
    logLevel: 5,
  });
}

// ---------- Mermaid Diagram Component ----------

let mermaidCounter = 0;

const MermaidDiagram: FC<{ code: string }> = ({ code }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(`mermaid-${Date.now()}-${++mermaidCounter}`);
  const [error, setError] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const diagramId = idRef.current;
    setIsRendering(true);

    async function render() {
      try {
        // First diagram on the page pays for fetching the mermaid engine here, so this
        // await can be seconds on a slow connection — hence the placeholder below.
        const { mermaid, domPurify } = await loadMermaid();
        if (cancelled) return;
        const { svg } = await mermaid.render(diagramId, code);
        if (!cancelled && containerRef.current) {
          const sanitizedSvg = domPurify.sanitize(svg, SVG_SANITIZE_CONFIG) as string;
          containerRef.current.innerHTML = sanitizedSvg;
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to render diagram');
        }
      } finally {
        if (!cancelled) setIsRendering(false);
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
        <div className="mb-2 text-fg-primary">Mermaid diagram error</div>
        {error}
      </div>
    );
  }

  return (
    <div className="mb-3">
      {/* Reserves space and announces progress while the engine chunk downloads and the
          diagram renders — otherwise this is an invisible gap mid-message. */}
      {isRendering && (
        <div
          className="flex items-center gap-2 px-4 py-3 min-h-16 text-fg-muted"
          role="status"
          aria-label="Rendering diagram"
          data-testid="mermaid-loading"
          style={{ fontSize: '0.8125rem' }}
        >
          <Spinner size="sm" />
          <span>Rendering diagram…</span>
        </div>
      )}
      <div ref={containerRef} data-testid="mermaid-diagram" className="overflow-auto" />
    </div>
  );
};

// ---------- Syntax Highlighted Code ----------

/** Background color from the nightOwl theme, used by code viewer containers */
export const CODE_THEME_BG = themes.nightOwl.plain.backgroundColor as string;

export const SyntaxHighlightedCode: FC<{ content: string; language: string }> = ({
  content,
  language,
}) => {
  return (
    <Highlight theme={themes.nightOwl} code={content} language={language || 'text'}>
      {({ style: themeStyle, tokens, getLineProps, getTokenProps }) => (
        <pre
          className="m-0 py-3 font-mono"
          style={{ ...themeStyle, fontSize: '0.8125rem', lineHeight: '1.5', overflow: 'auto' }}
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
                  className="inline-block w-12 text-right pr-3 text-fg-muted opacity-50 select-none shrink-0"
                  aria-hidden="true"
                >
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

// One child of a HAST element's `children` array (as produced by react-markdown's
// `node` prop) — a union of comment/element/text nodes, narrowed via `.type`.
type MarkdownHastChild = NonNullable<ExtraProps['node']>['children'][number];

export const RenderedMarkdown: FC<{ content: string; style?: CSSProperties; inline?: boolean }> = ({
  content,
  style,
  inline,
}) => {
  return (
    <div
      className={
        inline
          ? 'text-fg-primary leading-relaxed text-base overflow-x-hidden min-w-0 w-full'
          : 'max-w-[900px] mx-auto overflow-x-hidden p-4 text-fg-primary leading-relaxed text-base min-w-0 w-full'
      }
      style={{ ...style, overflowWrap: 'anywhere' }}
      data-testid="rendered-markdown"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="text-2xl mb-3 leading-tight" style={{ margin: '0 0 12px' }}>
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-2xl leading-snug" style={{ margin: '18px 0 10px' }}>
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-base leading-snug" style={{ margin: '16px 0 8px' }}>
              {children}
            </h3>
          ),
          p: ({ children }) => (
            <p className="mb-3" style={{ margin: '0 0 12px' }}>
              {children}
            </p>
          ),
          ul: ({ children }) => (
            <ul className="mb-3" style={{ margin: '0 0 12px', paddingLeft: 22 }}>
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-3" style={{ margin: '0 0 12px', paddingLeft: 22 }}>
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="mb-1">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-3 py-2 px-3 border-l-[3px] border-border-default bg-info-tint">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a
              href={sanitizeMarkdownHref(href)}
              target="_blank"
              rel="noreferrer noopener"
              className="text-tn-blue"
              style={{ overflowWrap: 'anywhere' }}
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto mb-3 max-w-full">
              <table className="border-collapse w-full min-w-80">{children}</table>
            </div>
          ),
          // `overflow-wrap: anywhere` on the markdown root lets the table layout
          // crush columns below word width (per-letter wrapping). `break-word`
          // keeps whole words in min-content sizing so the overflow-x wrapper
          // scrolls instead, while still breaking truly unbreakable tokens.
          th: ({ children }) => (
            <th
              className="border border-border-default px-2 py-1.5 text-left bg-info-tint"
              style={{ overflowWrap: 'break-word' }}
            >
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td
              className="border border-border-default px-2 py-1.5"
              style={{ overflowWrap: 'break-word' }}
            >
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
            const codeChild = node?.children?.find(
              (c: MarkdownHastChild) => c.type === 'element' && c.tagName === 'code'
            );
            if (codeChild?.properties?.className?.includes('language-mermaid')) {
              return <>{children}</>;
            }
            return <pre className="m-0 overflow-x-auto max-w-full">{children}</pre>;
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
                <div className="mb-3 overflow-hidden rounded-md">
                  <SyntaxHighlightedCode content={code} language={match[1] ?? ''} />
                </div>
              );
            }

            return (
              <code
                {...props}
                className="bg-info-tint rounded-sm font-mono"
                style={{ padding: '1px 5px', fontSize: '0.85em', overflowWrap: 'anywhere' }}
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
