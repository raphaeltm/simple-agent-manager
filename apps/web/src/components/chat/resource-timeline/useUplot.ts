import 'uplot/dist/uPlot.min.css';

import { type RefObject, useLayoutEffect, useRef } from 'react';
import uPlot from 'uplot';

/**
 * Owns one uPlot instance inside `containerRef`.
 *
 * The plot is rebuilt only when `options` changes identity (callers memoize it);
 * new `data` is pushed into the live plot, and the plot follows the container's
 * width. Hooks inside `options` should read mutable render state through refs so
 * that ordinary updates never rebuild the canvas.
 */
export function useUplot(
  containerRef: RefObject<HTMLDivElement | null>,
  options: Omit<uPlot.Options, 'width'>,
  data: uPlot.AlignedData
): RefObject<uPlot | null> {
  const plotRef = useRef<uPlot | null>(null);
  const dataRef = useRef(data);

  useLayoutEffect(() => {
    dataRef.current = data;
    plotRef.current?.setData(data, true);
  }, [data]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const plot = new uPlot(
      { ...options, width: Math.max(1, container.clientWidth) },
      dataRef.current,
      container
    );
    plotRef.current = plot;

    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry?.contentRect.width ?? 0);
      if (width > 0 && width !== plot.width) plot.setSize({ width, height: options.height });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [containerRef, options]);

  return plotRef;
}
