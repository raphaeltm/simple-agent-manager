import { Copy, Maximize2, RotateCcw, X } from 'lucide-react';
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { renderMermaidSvg } from '../mermaid';
import { MermaidViewport } from './MermaidViewport';

const NIGHT_OWL_CODE_BACKGROUND = '#011627';
const NIGHT_OWL_CODE_FOREGROUND = '#d6deeb';

let mermaidRenderCounter = 0;

function cleanupMermaidTempElements(diagramId: string) {
  document.getElementById(diagramId)?.remove();
  document.getElementById(`d${diagramId}`)?.remove();
}

async function renderDiagram(code: string, diagramId: string): Promise<string> {
  const [{ default: mermaid }, { default: domPurify }] = await Promise.all([
    import('mermaid'),
    import('dompurify'),
  ]);
  return renderMermaidSvg({ mermaid, domPurify }, diagramId, code);
}

function copyToClipboard(text: string) {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text);
  }
}

interface IconButtonProps {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}

function IconButton({
  label,
  onClick,
  children,
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-gray-700 bg-gray-900 text-gray-100 hover:bg-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
    >
      {children}
    </button>
  );
}

interface MermaidDiagramProps {
  readonly code: string;
}

export function MermaidDiagram({ code }: MermaidDiagramProps) {
  const reactId = useId();
  const diagramId = useMemo(
    () => `acp-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}-${++mermaidRenderCounter}`,
    [reactId],
  );
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const [svg, setSvg] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [resetToken, setResetToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSvg('');
    setError(null);
    renderDiagram(code, diagramId)
      .then((sanitizedSvg) => {
        cleanupMermaidTempElements(diagramId);
        if (!cancelled) setSvg(sanitizedSvg);
      })
      .catch((err: unknown) => {
        cleanupMermaidTempElements(diagramId);
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to render diagram');
        }
      });
    return () => {
      cancelled = true;
      cleanupMermaidTempElements(diagramId);
    };
  }, [code, diagramId]);

  useEffect(() => {
    if (!isFullscreen) return;
    const focusReturnTarget = expandButtonRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsFullscreen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      focusReturnTarget?.focus();
    };
  }, [isFullscreen]);

  const controls = (
    <>
      <IconButton label="Copy Mermaid source" onClick={() => copyToClipboard(code)}>
        <Copy aria-hidden="true" size={16} />
      </IconButton>
      <IconButton label="Reset diagram view" onClick={() => setResetToken((value) => value + 1)}>
        <RotateCcw aria-hidden="true" size={16} />
      </IconButton>
      <button
        ref={expandButtonRef}
        type="button"
        aria-label="Expand Mermaid diagram"
        title="Expand Mermaid diagram"
        onClick={() => setIsFullscreen(true)}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-gray-700 bg-gray-900 text-gray-100 hover:bg-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
      >
        <Maximize2 aria-hidden="true" size={16} />
      </button>
    </>
  );

  const fullscreenOverlay = isFullscreen ? createPortal(
    <dialog
      open
      aria-modal="true"
      aria-label="Mermaid diagram"
      data-testid="mermaid-diagram-fullscreen"
      className="fixed inset-0 z-[2147483647] flex flex-col bg-gray-950 text-gray-100"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483647,
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: '#030712',
        border: 'none',
        color: '#f3f4f6',
        height: 'auto',
        margin: 0,
        maxHeight: 'none',
        maxWidth: 'none',
        padding: 0,
        width: 'auto',
      }}
    >
      <div
        className="flex min-h-14 items-center justify-between gap-3 border-b border-gray-800 px-4 py-2"
        style={{
          alignItems: 'center',
          borderBottom: '1px solid #1f2937',
          display: 'flex',
          gap: '0.75rem',
          justifyContent: 'space-between',
          minHeight: '3.5rem',
          padding: '0.5rem 1rem',
        }}
      >
        <div className="min-w-0 text-sm font-medium">Mermaid diagram</div>
        <div className="flex shrink-0 items-center gap-2" style={{ display: 'flex', flexShrink: 0, gap: '0.5rem' }}>
          <IconButton label="Copy Mermaid source" onClick={() => copyToClipboard(code)}>
            <Copy aria-hidden="true" size={16} />
          </IconButton>
          <IconButton label="Reset diagram view" onClick={() => setResetToken((value) => value + 1)}>
            <RotateCcw aria-hidden="true" size={16} />
          </IconButton>
          <IconButton label="Close Mermaid diagram" onClick={() => setIsFullscreen(false)}>
            <X aria-hidden="true" size={16} />
          </IconButton>
        </div>
      </div>
      <div
        className="min-h-0 flex-1 p-3 sm:p-4"
        style={{ flex: 1, minHeight: 0, padding: '0.75rem' }}
      >
        <MermaidViewport
          svg={svg}
          testId="mermaid-diagram-fullscreen-svg"
          fullscreen
          resetToken={resetToken}
        />
      </div>
    </dialog>,
    document.body,
  ) : null;

  if (error) {
    return (
      <div
        data-testid="mermaid-diagram-error"
        className="my-2 min-w-0 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-950"
        style={{
          backgroundColor: '#2a1215',
          border: '1px solid #ef4444',
          color: '#fecaca',
        }}
      >
        <div className="font-medium" style={{ color: '#fee2e2', fontWeight: 600 }}>
          Mermaid diagram error
        </div>
        <div className="mt-1 break-words text-red-800" style={{ color: '#fecaca', marginTop: '0.25rem' }}>{error}</div>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => copyToClipboard(code)}
            className="inline-flex min-h-9 items-center gap-2 rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm text-red-900 hover:bg-red-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500"
            style={{
              alignItems: 'center',
              backgroundColor: '#111827',
              border: '1px solid #ef4444',
              color: '#fee2e2',
              display: 'inline-flex',
              gap: '0.5rem',
              minHeight: '2.25rem',
              padding: '0.375rem 0.75rem',
            }}
          >
            <Copy aria-hidden="true" size={15} />
            Copy source
          </button>
        </div>
        <details className="mt-3">
          <summary className="cursor-pointer text-red-900" style={{ color: '#fee2e2', cursor: 'pointer' }}>
            View source
          </summary>
          <pre
            className="mt-2 max-h-48 overflow-auto rounded-md bg-red-950 p-3 text-xs text-red-50"
            style={{
              backgroundColor: '#111827',
              color: '#fee2e2',
              maxHeight: '12rem',
              overflow: 'auto',
              padding: '0.75rem',
            }}
          >
            {code}
          </pre>
        </details>
      </div>
    );
  }

  return (
    <div
      data-testid="mermaid-diagram"
      className="my-2 min-w-0 overflow-hidden rounded-lg border border-gray-700 bg-gray-950 text-gray-100"
    >
      <div className="flex min-h-12 items-center justify-between gap-2 border-b border-gray-800 px-3 py-2">
        <div className="min-w-0 truncate text-sm font-medium">Diagram</div>
        <div className="flex shrink-0 items-center gap-1.5">{controls}</div>
      </div>
      {svg ? (
        <MermaidViewport svg={svg} testId="mermaid-diagram-svg" resetToken={resetToken} />
      ) : (
        <div
          data-testid="mermaid-diagram-loading"
          className="flex h-[180px] items-center justify-center rounded-b-lg bg-[#0b1110] text-sm text-gray-400"
        >
          Rendering diagram
        </div>
      )}

      {fullscreenOverlay}
    </div>
  );
}

interface MermaidCodeFallbackProps {
  readonly code: string;
  readonly style?: CSSProperties;
}

export function MermaidCodeFallback({ code, style }: MermaidCodeFallbackProps) {
  return (
    <pre
      data-testid="mermaid-code-fallback"
      className="p-3 rounded-md overflow-x-auto text-xs whitespace-pre"
      style={{
        margin: 0,
        background: NIGHT_OWL_CODE_BACKGROUND,
        color: NIGHT_OWL_CODE_FOREGROUND,
        fontFamily: 'monospace',
        lineHeight: '1.5',
        ...style,
      }}
    >
      {code}
    </pre>
  );
}
