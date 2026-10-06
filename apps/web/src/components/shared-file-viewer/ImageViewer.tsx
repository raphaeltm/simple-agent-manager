import { Spinner } from '@simple-agent-manager/ui';
import { type FC, type PointerEvent as ReactPointerEvent, type SyntheticEvent, useCallback, useEffect, useRef, useState } from 'react';

import {
  FILE_PREVIEW_INLINE_MAX_BYTES,
  FILE_PREVIEW_LOAD_MAX_BYTES,
  formatFileSize,
} from '../../lib/file-utils';

interface ImageViewerProps {
  /** URL to fetch the raw image from. */
  src: string;
  /** File name for display. */
  fileName: string;
  /** File size in bytes (if known from directory listing). */
  fileSize?: number;
}

interface Point {
  x: number;
  y: number;
}

interface Transform {
  scale: number;
  x: number;
  y: number;
}

const FIT_SCALE = 1;
const DEFAULT_ACTUAL_SCALE = 2;
const MAX_SCALE = 4;
const DOUBLE_TAP_MS = 300;
const TAP_MOVE_TOLERANCE_PX = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function getPointerPoint(e: ReactPointerEvent): Point {
  return { x: e.clientX, y: e.clientY };
}

function constrainTransform(transform: Transform, container: HTMLElement | null): Transform {
  if (transform.scale <= FIT_SCALE || !container) {
    return { scale: FIT_SCALE, x: 0, y: 0 };
  }

  const rect = container.getBoundingClientRect();
  const boundX = Math.max(0, (rect.width * (transform.scale - FIT_SCALE)) / 2);
  const boundY = Math.max(0, (rect.height * (transform.scale - FIT_SCALE)) / 2);

  return {
    scale: clamp(transform.scale, FIT_SCALE, MAX_SCALE),
    x: clamp(transform.x, -boundX, boundX),
    y: clamp(transform.y, -boundY, boundY),
  };
}

function useImageTransform(dimensions: { w: number; h: number } | null) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const gestureStartRef = useRef<{
    points: Point[];
    transform: Transform;
    distance?: number;
    center?: Point;
  } | null>(null);
  const lastTapRef = useRef<{ time: number; point: Point } | null>(null);
  const pointerDownRef = useRef<Point | null>(null);
  const movedRef = useRef(false);
  const [transform, setTransform] = useState<Transform>({ scale: FIT_SCALE, x: 0, y: 0 });

  const actualScale = useCallback(() => {
    const container = containerRef.current;
    if (!container || !dimensions) return DEFAULT_ACTUAL_SCALE;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return DEFAULT_ACTUAL_SCALE;
    const fitRatio = Math.min(rect.width / dimensions.w, rect.height / dimensions.h, 1);
    if (fitRatio <= 0) return DEFAULT_ACTUAL_SCALE;
    return clamp(1 / fitRatio, FIT_SCALE, MAX_SCALE);
  }, [dimensions]);

  const zoomToFit = useCallback(() => {
    setTransform({ scale: FIT_SCALE, x: 0, y: 0 });
  }, []);

  const zoomAt = useCallback((targetScale: number, point?: Point) => {
    const container = containerRef.current;
    if (targetScale <= FIT_SCALE || !container) {
      zoomToFit();
      return;
    }

    const rect = container.getBoundingClientRect();
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const focalPoint = point ?? center;
    const next = {
      scale: clamp(targetScale, FIT_SCALE, MAX_SCALE),
      x: -(focalPoint.x - center.x) * (targetScale - FIT_SCALE),
      y: -(focalPoint.y - center.y) * (targetScale - FIT_SCALE),
    };
    setTransform(constrainTransform(next, container));
  }, [zoomToFit]);

  const toggleZoomAt = useCallback((point?: Point) => {
    setTransform((current) => {
      if (current.scale > FIT_SCALE) return { scale: FIT_SCALE, x: 0, y: 0 };
      const container = containerRef.current;
      if (!container) return { scale: DEFAULT_ACTUAL_SCALE, x: 0, y: 0 };
      const rect = container.getBoundingClientRect();
      const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const focalPoint = point ?? center;
      const nextScale = DEFAULT_ACTUAL_SCALE;
      return constrainTransform({
        scale: nextScale,
        x: -(focalPoint.x - center.x) * (nextScale - FIT_SCALE),
        y: -(focalPoint.y - center.y) * (nextScale - FIT_SCALE),
      }, container);
    });
  }, []);

  const zoomToActual = useCallback(() => {
    zoomAt(actualScale());
  }, [actualScale, zoomAt]);

  const beginGesture = useCallback(() => {
    const points = Array.from(pointersRef.current.values());
    const firstPoint = points[0];
    if (!firstPoint) {
      gestureStartRef.current = null;
      return;
    }
    const secondPoint = points[1];
    gestureStartRef.current = {
      points,
      transform,
      distance: secondPoint ? distance(firstPoint, secondPoint) : undefined,
      center: secondPoint ? midpoint(firstPoint, secondPoint) : firstPoint,
    };
  }, [transform]);

  const handlePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const point = getPointerPoint(e);
    pointersRef.current.set(e.pointerId, point);
    pointerDownRef.current = point;
    movedRef.current = false;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    beginGesture();
  }, [beginGesture]);

  const handlePointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    const point = getPointerPoint(e);
    const downPoint = pointerDownRef.current;
    if (downPoint && distance(downPoint, point) > TAP_MOVE_TOLERANCE_PX) {
      movedRef.current = true;
    }
    pointersRef.current.set(e.pointerId, point);

    const start = gestureStartRef.current;
    const points = Array.from(pointersRef.current.values());
    if (!start || points.length === 0) return;

    const firstPoint = points[0];
    const secondPoint = points[1];
    const startFirstPoint = start.points[0];
    const startSecondPoint = start.points[1];

    if (firstPoint && secondPoint && startFirstPoint && startSecondPoint && start.distance && start.center) {
      const currentDistance = distance(firstPoint, secondPoint);
      const currentCenter = midpoint(firstPoint, secondPoint);
      const nextScale = clamp(start.transform.scale * (currentDistance / start.distance), FIT_SCALE, MAX_SCALE);
      setTransform(constrainTransform({
        scale: nextScale,
        x: start.transform.x + (currentCenter.x - start.center.x),
        y: start.transform.y + (currentCenter.y - start.center.y),
      }, containerRef.current));
      return;
    }

    if (firstPoint && startFirstPoint && points.length === 1 && start.points.length === 1 && transform.scale > FIT_SCALE) {
      setTransform(constrainTransform({
        scale: start.transform.scale,
        x: start.transform.x + (firstPoint.x - startFirstPoint.x),
        y: start.transform.y + (firstPoint.y - startFirstPoint.y),
      }, containerRef.current));
    }
  }, [transform.scale]);

  const handlePointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const point = getPointerPoint(e);
    pointersRef.current.delete(e.pointerId);
    e.currentTarget.releasePointerCapture?.(e.pointerId);

    if (!movedRef.current && e.pointerType === 'mouse') {
      toggleZoomAt(point);
    }

    if (!movedRef.current && e.pointerType !== 'mouse') {
      const now = Date.now();
      const lastTap = lastTapRef.current;
      if (lastTap && now - lastTap.time <= DOUBLE_TAP_MS && distance(lastTap.point, point) <= 48) {
        toggleZoomAt(point);
        lastTapRef.current = null;
      } else {
        lastTapRef.current = { time: now, point };
      }
    }

    beginGesture();
  }, [beginGesture, toggleZoomAt]);

  const handlePointerCancel = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(e.pointerId);
    beginGesture();
  }, [beginGesture]);

  useEffect(() => {
    setTransform({ scale: FIT_SCALE, x: 0, y: 0 });
    pointersRef.current.clear();
    gestureStartRef.current = null;
  }, [dimensions]);

  return {
    containerRef,
    transform,
    zoomToFit,
    zoomToActual,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
  };
}

/**
 * Renders an image with transform-based zoom/pan gestures, metadata display,
 * and size-based guardrails (click-to-load for large files, download-only for very large).
 *
 * Images are rendered via <img src> tag — SVGs are safe in this context
 * because browsers block script execution inside <img> elements.
 */
export const ImageViewer: FC<ImageViewerProps> = ({ src, fileName, fileSize }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(null);
  const [userConfirmedLoad, setUserConfirmedLoad] = useState(false);
  const {
    containerRef,
    transform,
    zoomToFit,
    zoomToActual,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
  } = useImageTransform(dimensions);

  // Determine size tier
  const isLargeFile = fileSize != null && fileSize > FILE_PREVIEW_INLINE_MAX_BYTES;
  const isTooLarge = fileSize != null && fileSize > FILE_PREVIEW_LOAD_MAX_BYTES;

  // Should we show the image?
  const shouldRender = !isTooLarge && (!isLargeFile || userConfirmedLoad);

  const handleLoad = useCallback((e: SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setDimensions({ w: img.naturalWidth, h: img.naturalHeight });
    setLoading(false);
  }, []);

  const handleError = useCallback(() => {
    setLoading(false);
    setError(true);
  }, []);

  // Reset state when src changes
  useEffect(() => {
    setLoading(true);
    setError(false);
    setDimensions(null);
    setUserConfirmedLoad(false);
  }, [src]);

  // Too large — download only
  if (isTooLarge) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-12 text-fg-muted">
        <div className="text-sm font-medium">File too large to preview</div>
        {fileSize != null && (
          <div className="text-xs">{formatFileSize(fileSize)}</div>
        )}
        <a
          href={src}
          download={fileName}
          className="rounded-md bg-accent-primary px-4 py-2 text-sm font-medium text-fg-on-accent no-underline hover:opacity-90"
        >
          Download
        </a>
      </div>
    );
  }

  // Large file — click to load
  if (isLargeFile && !userConfirmedLoad) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-12 text-fg-muted">
        <div className="text-sm font-medium">Large image</div>
        {fileSize != null && (
          <div className="text-xs">{formatFileSize(fileSize)}</div>
        )}
        <button
          type="button"
          onClick={() => setUserConfirmedLoad(true)}
          className="cursor-pointer rounded-md border-none bg-accent-primary px-4 py-2 text-sm font-medium text-fg-on-accent hover:opacity-90"
        >
          Load preview
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Metadata bar */}
      {(!loading || dimensions) && !error && (
        <div className="flex shrink-0 items-center gap-3 border-b border-border-default bg-surface px-3 py-1.5 text-xs text-fg-muted">
          {dimensions && (
            <span>{dimensions.w} &times; {dimensions.h}</span>
          )}
          {fileSize != null && fileSize > 0 && (
            <span>{formatFileSize(fileSize)}</span>
          )}
          <button
            type="button"
            onClick={transform.scale > FIT_SCALE ? zoomToFit : zoomToActual}
            className="ml-auto cursor-pointer rounded border border-border-default bg-transparent px-2 py-0.5 text-[11px] font-medium text-fg-muted hover:text-fg-primary"
          >
            {transform.scale > FIT_SCALE ? 'Fit to panel' : 'Actual size (1:1)'}
          </button>
        </div>
      )}

      {/* Image area */}
      <div
        ref={containerRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        style={{ touchAction: 'none' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      >
        {loading && !error && (
          <div className="flex w-full justify-center p-8">
            <Spinner size="md" />
          </div>
        )}

        {error && (
          <div
            className="m-4 rounded-lg bg-danger-tint p-3"
            style={{ fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-tn-red)' }}
          >
            Failed to load image
          </div>
        )}

        {shouldRender && (
          <img
            src={src}
            alt={fileName}
            draggable={false}
            onLoad={handleLoad}
            onError={handleError}
            className="max-h-full max-w-full select-none object-contain"
            style={{
              display: 'block',
              visibility: loading ? 'hidden' : 'visible',
              cursor: transform.scale > FIT_SCALE ? 'grab' : 'zoom-in',
              transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
              transformOrigin: 'center center',
              transition: 'transform 120ms ease-out',
            }}
          />
        )}
      </div>
    </div>
  );
};
