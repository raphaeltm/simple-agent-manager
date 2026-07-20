import { Spinner } from '@simple-agent-manager/ui';
import DOMPurify from 'dompurify';
import { AlertTriangle, Code, Eye } from 'lucide-react';
import { type FC, useEffect, useState } from 'react';

import { FOCUS_RING } from '../library/types';
import { SyntaxHighlightedCode } from '../MarkdownRenderer';

const DEFAULT_HTML_FETCH_TIMEOUT_MS = 30_000;
const HTML_FETCH_TIMEOUT_MS = import.meta.env.VITE_HTML_FETCH_TIMEOUT_MS
  ? parseInt(import.meta.env.VITE_HTML_FETCH_TIMEOUT_MS, 10)
  : DEFAULT_HTML_FETCH_TIMEOUT_MS;
const HTML_SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
const HTML_SANDBOX_META = `<meta http-equiv="Content-Security-Policy" content="${HTML_SANDBOX_CSP}">`;

const HTML_PREVIEW_SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: [
    'base',
    'embed',
    'form',
    'iframe',
    'input',
    'link',
    'meta',
    'object',
    'script',
    'textarea',
  ],
  FORBID_ATTR: [
    'action',
    'formaction',
    'href',
    'ping',
    'srcdoc',
    'target',
  ],
  ALLOWED_URI_REGEXP: /^(?:(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$)))/i,
};

interface HtmlViewerProps {
  previewUrl: string;
  fileName: string;
  onContentStateChange?: (loaded: boolean) => void;
}

export function buildSandboxedHtmlSrcDoc(content: string): string {
  const sanitizedContent = DOMPurify.sanitize(
    content,
    HTML_PREVIEW_SANITIZE_CONFIG,
  ) as string;
  const headMatch = sanitizedContent.match(/<head\b[^>]*>/i);
  if (headMatch?.index !== undefined) {
    const insertAt = headMatch.index + headMatch[0].length;
    return `${sanitizedContent.slice(0, insertAt)}${HTML_SANDBOX_META}${sanitizedContent.slice(insertAt)}`;
  }

  const htmlMatch = sanitizedContent.match(/<html\b[^>]*>/i);
  if (htmlMatch?.index !== undefined) {
    const insertAt = htmlMatch.index + htmlMatch[0].length;
    return `${sanitizedContent.slice(0, insertAt)}<head>${HTML_SANDBOX_META}</head>${sanitizedContent.slice(insertAt)}`;
  }

  return `${HTML_SANDBOX_META}${sanitizedContent}`;
}

export const HtmlViewer: FC<HtmlViewerProps> = ({
  previewUrl,
  fileName,
  onContentStateChange,
}) => {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'rendered' | 'source'>('rendered');
  const [renderedSrcDoc, setRenderedSrcDoc] = useState<string | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTML_FETCH_TIMEOUT_MS);
    setLoading(true);
    setError(null);
    setContent(null);
    onContentStateChange?.(false);

    fetch(previewUrl, { credentials: 'include', signal: controller.signal })
      .then((resp) => {
        if (!resp.ok) throw new Error(`Failed to load file (${resp.status})`);
        return resp.text();
      })
      .then((text) => {
        if (!controller.signal.aborted) {
          setContent(text);
          setLoading(false);
          onContentStateChange?.(true);
        }
      })
      .catch((err: Error) => {
        if (!controller.signal.aborted) {
          setError(err.name === 'AbortError' ? 'Request timed out' : err.message);
          setLoading(false);
          onContentStateChange?.(false);
        }
      })
      .finally(() => clearTimeout(timer));

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [onContentStateChange, previewUrl]);

  useEffect(() => {
    setRenderedSrcDoc(undefined);
    if (viewMode !== 'rendered' || content === null) return undefined;
    const frame = requestAnimationFrame(() => setRenderedSrcDoc(buildSandboxedHtmlSrcDoc(content)));
    return () => cancelAnimationFrame(frame);
  }, [content, viewMode]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size="md" />
      </div>
    );
  }

  if (error || content === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <AlertTriangle size={32} className="text-warning" />
        <p className="text-sm text-fg-muted">
          Unable to load HTML preview. Try downloading the file instead.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-end border-b border-border-default bg-surface px-3 py-2">
        <div className="flex shrink-0 overflow-hidden rounded-lg border border-border-default">
          <button
            type="button"
            onClick={() => setViewMode('rendered')}
            aria-label="Rendered view"
            aria-pressed={viewMode === 'rendered'}
            className={`flex items-center gap-1.5 border-none px-2.5 py-2 text-xs ${FOCUS_RING} ${
              viewMode === 'rendered'
                ? 'bg-accent/10 text-accent'
                : 'bg-[color-mix(in_srgb,var(--sam-glass-nested-bg)_80%,transparent)] text-fg-muted hover:text-fg-primary'
            }`}
          >
            <Eye size={14} />
            Rendered
          </button>
          <button
            type="button"
            onClick={() => setViewMode('source')}
            aria-label="Source view"
            aria-pressed={viewMode === 'source'}
            className={`flex items-center gap-1.5 border-none px-2.5 py-2 text-xs ${FOCUS_RING} ${
              viewMode === 'source'
                ? 'bg-accent/10 text-accent'
                : 'bg-[color-mix(in_srgb,var(--sam-glass-nested-bg)_80%,transparent)] text-fg-muted hover:text-fg-primary'
            }`}
          >
            <Code size={14} />
            Source
          </button>
        </div>
      </div>

      {viewMode === 'rendered' ? (
        <iframe
          srcDoc={renderedSrcDoc}
          sandbox=""
          referrerPolicy="no-referrer"
          title={fileName}
          className="h-full w-full flex-1 border-0 bg-white"
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto bg-surface-inset p-4">
          <SyntaxHighlightedCode content={content} language="markup" />
        </div>
      )}
    </div>
  );
};
