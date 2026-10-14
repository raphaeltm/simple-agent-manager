import { type CSSProperties, useEffect, useRef } from 'react';

import {
  createGlassNodeField,
  type GlassNodeFieldHandle,
  type GlassNodeFieldMode,
  type GlassNodeFieldTheme,
} from '../glass/node-field';

export interface GlassNodeFieldProps {
  mode?: GlassNodeFieldMode;
  theme?: GlassNodeFieldTheme | 'auto';
  seed?: number;
  pitch?: number;
  density?: number;
  vanishX?: number;
  horizonY?: number;
  /** Receives the renderer handle (pin, burst, pause …) once it exists, and `null` on teardown. */
  onReady?: (handle: GlassNodeFieldHandle | null) => void;
  className?: string;
  style?: CSSProperties;
}

/**
 * Decorative background: SAM's square node/workspace network as lit glass.
 * Fills its positioned parent; purely visual (`aria-hidden`), so it never takes focus.
 */
export function GlassNodeField({
  mode = 'floor',
  theme = 'auto',
  seed,
  pitch,
  density,
  vanishX,
  horizonY,
  onReady,
  className,
  style,
}: GlassNodeFieldProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  // Keep the latest callback without re-creating the field when its identity changes.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  // Only primitive props are dependencies, so an inline parent object never rebuilds the canvas.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const handle = createGlassNodeField(root, { mode, theme, seed, pitch, density, vanishX, horizonY });
    handle.start();
    onReadyRef.current?.(handle);
    return () => {
      onReadyRef.current?.(null);
      handle.destroy();
    };
  }, [mode, theme, seed, pitch, density, vanishX, horizonY]);

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      data-testid="glass-node-field"
      className={className}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', ...style }}
    />
  );
}
