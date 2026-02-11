const APP_HEIGHT_VAR = '--sam-app-height';
const KEYBOARD_OFFSET_VAR = '--sam-keyboard-offset';
const KEYBOARD_CLASS = 'sam-keyboard-open';
const KEYBOARD_OPEN_THRESHOLD_PX = 120;

export interface ViewportMetrics {
  appHeightPx: string;
  keyboardOffsetPx: string;
  keyboardOpen: boolean;
}

interface ViewportDimensions {
  layoutHeight: number;
  visualHeight: number;
  visualOffsetTop: number;
}

/**
 * Computes CSS-ready viewport metrics from layout + visual viewport dimensions.
 */
export function computeViewportMetrics(dimensions: ViewportDimensions): ViewportMetrics {
  const layoutHeight = Math.max(0, Math.round(dimensions.layoutHeight));
  const visualHeight = Math.max(0, Math.round(dimensions.visualHeight));
  const visualOffsetTop = Math.max(0, Math.round(dimensions.visualOffsetTop));

  const appHeight = Math.max(visualHeight, 0);
  const keyboardOffset = Math.max(layoutHeight - (visualHeight + visualOffsetTop), 0);

  return {
    appHeightPx: `${appHeight}px`,
    keyboardOffsetPx: `${keyboardOffset}px`,
    keyboardOpen: keyboardOffset >= KEYBOARD_OPEN_THRESHOLD_PX,
  };
}

/**
 * Applies viewport metrics to the document root as CSS variables + class toggle.
 */
export function applyViewportMetrics(doc: Document, metrics: ViewportMetrics): void {
  const root = doc.documentElement;
  root.style.setProperty(APP_HEIGHT_VAR, metrics.appHeightPx);
  root.style.setProperty(KEYBOARD_OFFSET_VAR, metrics.keyboardOffsetPx);
  root.classList.toggle(KEYBOARD_CLASS, metrics.keyboardOpen);
}

/**
 * Syncs visual viewport changes into CSS vars so mobile layouts respect browser UI + keyboard.
 */
export function startMobileViewportSync(
  win: Window = window,
  doc: Document = document
): () => void {
  const visualViewport = win.visualViewport;

  const update = () => {
    const layoutHeight = win.innerHeight || doc.documentElement.clientHeight;
    const visualHeight = visualViewport?.height ?? layoutHeight;
    const visualOffsetTop = visualViewport?.offsetTop ?? 0;

    applyViewportMetrics(
      doc,
      computeViewportMetrics({ layoutHeight, visualHeight, visualOffsetTop })
    );
  };

  update();
  win.addEventListener('resize', update);
  win.addEventListener('orientationchange', update);
  visualViewport?.addEventListener('resize', update);
  visualViewport?.addEventListener('scroll', update);

  return () => {
    win.removeEventListener('resize', update);
    win.removeEventListener('orientationchange', update);
    visualViewport?.removeEventListener('resize', update);
    visualViewport?.removeEventListener('scroll', update);
  };
}
