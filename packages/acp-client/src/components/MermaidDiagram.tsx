import DOMPurify from 'dompurify';
import { Copy, Maximize2, RotateCcw, X } from 'lucide-react';
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type WheelEvent,
} from 'react';
import { createPortal } from 'react-dom';

import { MERMAID_SVG_SANITIZE_CONFIG } from '../mermaid';

export { MERMAID_SVG_SANITIZE_CONFIG } from '../mermaid';

const MERMAID_FONT =
  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

const NIGHT_OWL_CODE_BACKGROUND = '#011627';
const NIGHT_OWL_CODE_FOREGROUND = '#d6deeb';

const MERMAID_THEME_VARIABLES = {
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
  fontFamily: MERMAID_FONT,
};

let mermaidInitialized = false;
let mermaidRenderCounter = 0;

function cleanupMermaidTempElements(diagramId: string) {
  document.getElementById(diagramId)?.remove();
  document.getElementById(`d${diagramId}`)?.remove();
}

async function renderMermaidSvg(code: string, diagramId: string): Promise<string> {
  const mermaidModule = await import('mermaid');
  const mermaid = mermaidModule.default;
  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      themeVariables: MERMAID_THEME_VARIABLES,
      fontFamily: MERMAID_FONT,
      securityLevel: 'strict',
      logLevel: 5,
    });
    mermaidInitialized = true;
  }

  const { svg } = await mermaid.render(diagramId, code);
  return DOMPurify.sanitize(svg, MERMAID_SVG_SANITIZE_CONFIG);
}

function copyToClipboard(text: string) {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text);
  }
}

function getSvgFromContainer(container: HTMLDivElement | null): SVGSVGElement | null {
  return container?.querySelector('svg') ?? null;
}

function parseViewBox(svg: SVGSVGElement | null): [number, number, number, number] | null {
  const raw = svg?.getAttribute('viewBox');
  if (!raw) return null;
  const values = raw.split(/[\s,]+/).map(Number);
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
    return null;
  }
  return values as [number, number, number, number];
}

function getPointerDistance(
  first: { clientX: number; clientY: number },
  second: { clientX: number; clientY: number },
) {
  return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
}

function getPointerCenter(
  first: { clientX: number; clientY: number },
  second: { clientX: number; clientY: number },
) {
  return {
    clientX: (first.clientX + second.clientX) / 2,
    clientY: (first.clientY + second.clientY) / 2,
  };
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

interface MermaidViewportProps {
  readonly svg: string;
  readonly testId: string;
  readonly fullscreen?: boolean;
  readonly resetToken: number;
}

function MermaidViewport({
  svg,
  testId,
  fullscreen = false,
  resetToken,
}: MermaidViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activePointersRef = useRef(new Map<number, { clientX: number; clientY: number }>());
  const gestureRef = useRef<
    | {
        type: 'pan';
        pointerId: number;
        startX: number;
        startY: number;
        viewBox: [number, number, number, number];
      }
    | {
        type: 'pinch';
        startDistance: number;
        startCenter: { clientX: number; clientY: number };
        viewBox: [number, number, number, number];
      }
    | null
  >(null);
  const baseViewBoxRef = useRef<[number, number, number, number] | null>(null);

  const reset = useCallback(() => {
    const svgElement = getSvgFromContainer(containerRef.current);
    const baseViewBox = baseViewBoxRef.current ?? parseViewBox(svgElement);
    if (!svgElement || !baseViewBox) return;
    baseViewBoxRef.current = baseViewBox;
    svgElement.setAttribute('viewBox', baseViewBox.join(' '));
  }, []);

  useEffect(() => {
    const svgElement = getSvgFromContainer(containerRef.current);
    const baseViewBox = parseViewBox(svgElement);
    if (!svgElement || !baseViewBox) return;
    baseViewBoxRef.current = baseViewBox;
    svgElement.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svgElement.style.maxWidth = 'none';
    svgElement.style.width = '100%';
    svgElement.style.height = '100%';
  }, [svg]);

  useEffect(() => {
    reset();
  }, [reset, resetToken]);

  const applyZoom = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const svgElement = getSvgFromContainer(containerRef.current);
    const viewBox = parseViewBox(svgElement);
    const rect = containerRef.current?.getBoundingClientRect();
    if (!svgElement || !viewBox || !rect) return;

    const [x, y, width, height] = viewBox;
    const zoomFactor = event.deltaY < 0 ? 0.88 : 1.14;
    const nextWidth = width * zoomFactor;
    const nextHeight = height * zoomFactor;
    const pointerX = (event.clientX - rect.left) / Math.max(rect.width, 1);
    const pointerY = (event.clientY - rect.top) / Math.max(rect.height, 1);
    const nextX = x + (width - nextWidth) * pointerX;
    const nextY = y + (height - nextHeight) * pointerY;
    svgElement.setAttribute('viewBox', `${nextX} ${nextY} ${nextWidth} ${nextHeight}`);
  };

  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const svgElement = getSvgFromContainer(containerRef.current);
    const viewBox = parseViewBox(svgElement);
    if (!viewBox) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic events and some older touch implementations can reject capture.
      // The gesture still works as long as subsequent pointer events reach us.
    }
    activePointersRef.current.set(event.pointerId, {
      clientX: event.clientX,
      clientY: event.clientY,
    });

    const pointers = Array.from(activePointersRef.current.values());
    if (pointers.length >= 2) {
      const [first, second] = pointers;
      if (!first || !second) return;
      gestureRef.current = {
        type: 'pinch',
        startDistance: Math.max(getPointerDistance(first, second), 1),
        startCenter: getPointerCenter(first, second),
        viewBox,
      };
      return;
    }

    gestureRef.current = {
      type: 'pan',
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      viewBox,
    };
  };

  const pan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const svgElement = getSvgFromContainer(containerRef.current);
    const rect = containerRef.current?.getBoundingClientRect();
    const gesture = gestureRef.current;
    if (!gesture || !svgElement || !rect || !activePointersRef.current.has(event.pointerId)) return;

    activePointersRef.current.set(event.pointerId, {
      clientX: event.clientX,
      clientY: event.clientY,
    });

    if (gesture.type === 'pinch') {
      const pointers = Array.from(activePointersRef.current.values());
      if (pointers.length < 2) return;
      const [first, second] = pointers;
      if (!first || !second) return;
      const [x, y, width, height] = gesture.viewBox;
      const currentDistance = Math.max(getPointerDistance(first, second), 1);
      const scale = gesture.startDistance / currentDistance;
      const nextWidth = width * scale;
      const nextHeight = height * scale;
      const pointerX = (gesture.startCenter.clientX - rect.left) / Math.max(rect.width, 1);
      const pointerY = (gesture.startCenter.clientY - rect.top) / Math.max(rect.height, 1);
      const nextX = x + (width - nextWidth) * pointerX;
      const nextY = y + (height - nextHeight) * pointerY;
      svgElement.setAttribute('viewBox', `${nextX} ${nextY} ${nextWidth} ${nextHeight}`);
      return;
    }

    if (gesture.pointerId !== event.pointerId) return;
    const [x, y, width, height] = gesture.viewBox;
    const dx = ((event.clientX - gesture.startX) / Math.max(rect.width, 1)) * width;
    const dy = ((event.clientY - gesture.startY) / Math.max(rect.height, 1)) * height;
    svgElement.setAttribute('viewBox', `${x - dx} ${y - dy} ${width} ${height}`);
  };

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    activePointersRef.current.delete(event.pointerId);
    const pointers = Array.from(activePointersRef.current.entries());
    if (pointers.length === 1) {
      const remainingPointer = pointers[0];
      if (!remainingPointer) return;
      const [pointerId, pointer] = remainingPointer;
      const viewBox = parseViewBox(getSvgFromContainer(containerRef.current));
      if (viewBox && pointer) {
        gestureRef.current = {
          type: 'pan',
          pointerId,
          startX: pointer.clientX,
          startY: pointer.clientY,
          viewBox,
        };
        return;
      }
    }
    gestureRef.current = null;
  };

  return (
    <div
      ref={containerRef}
      data-testid={testId}
      className={`min-w-0 overflow-hidden bg-[#0b1110] ${
        fullscreen ? 'h-full rounded-lg' : 'h-[260px] max-h-[420px] rounded-b-lg'
      }`}
      style={{
        touchAction: 'none',
        minWidth: 0,
        overflow: 'hidden',
        backgroundColor: '#0b1110',
        height: fullscreen ? '100%' : '260px',
        maxHeight: fullscreen ? undefined : '420px',
        borderBottomLeftRadius: fullscreen ? undefined : '0.5rem',
        borderBottomRightRadius: fullscreen ? undefined : '0.5rem',
      }}
      onWheel={applyZoom}
      onPointerDown={startPan}
      onPointerMove={pan}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
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
    renderMermaidSvg(code, diagramId)
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
        <div className="min-w-0 text-sm font-medium">Diagram</div>
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
