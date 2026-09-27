import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  type WheelEvent,
} from 'react';

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
  second: { clientX: number; clientY: number }
) {
  return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
}

function getPointerCenter(
  first: { clientX: number; clientY: number },
  second: { clientX: number; clientY: number }
) {
  return {
    clientX: (first.clientX + second.clientX) / 2,
    clientY: (first.clientY + second.clientY) / 2,
  };
}

interface MermaidViewportProps {
  readonly svg: string;
  readonly testId: string;
  readonly fullscreen?: boolean;
  readonly resetToken: number;
}

export function MermaidViewport({
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
