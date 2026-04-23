import mermaid from 'mermaid';

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'loose',
  theme: 'base',
  themeVariables: {
    background: '#13201d',
    primaryColor: '#13201d',
    primaryTextColor: '#e6f2ee',
    primaryBorderColor: '#2f6d58',
    lineColor: '#6ed79a',
    secondaryColor: '#0e1a17',
    secondaryTextColor: '#d6e8e0',
    tertiaryColor: '#162723',
    tertiaryTextColor: '#9fb7ae',
    clusterBkg: '#101b18',
    clusterBorder: '#2f6d58',
    edgeLabelBackground: '#0b1110',
    nodeBorder: '#3f7a63',
    fontFamily:
      'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  flowchart: {
    curve: 'basis',
    useMaxWidth: false,
    htmlLabels: false,
  },
});

const diagramBlocks = Array.from(
  document.querySelectorAll<HTMLElement>('.post-body [data-language="mermaid"]')
);

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const getDistance = (
  first: { x: number; y: number },
  second: { x: number; y: number }
) => Math.hypot(second.x - first.x, second.y - first.y);

const getMidpoint = (
  first: { x: number; y: number },
  second: { x: number; y: number }
) => ({
  x: (first.x + second.x) / 2,
  y: (first.y + second.y) / 2,
});

const attachPanZoom = (surface: HTMLElement, svg: SVGElement) => {
  const isMobile = window.innerWidth < 640;
  const viewBoxAttr = svg.getAttribute('viewBox');
  if (!viewBoxAttr) {
    return { reset: () => {} };
  }

  const [baseMinX, baseMinY, baseWidth, baseHeight] = viewBoxAttr
    .split(/[\s,]+/)
    .map(Number);

  surface.style.setProperty('--mermaid-diagram-ratio', `${baseWidth} / ${baseHeight}`);

  const baseCenterX = baseMinX + baseWidth / 2;
  const baseCenterY = baseMinY + baseHeight / 2;
  const getShell = () => surface.closest<HTMLElement>('.mermaid-shell');
  const getDefaultZoom = () => {
    const isFullscreen = getShell()?.classList.contains('is-fullscreen');
    if (isMobile) {
      return isFullscreen ? 1 : 1;
    }

    return isFullscreen ? 1 : 1;
  };
  const getMaxZoom = () => (isMobile ? 18 : 10);

  let zoom = getDefaultZoom();
  let centerX = baseCenterX;
  let centerY = baseCenterY;
  let gestureStartZoom = zoom;
  let gestureStartCenterX = baseCenterX;
  let gestureStartCenterY = baseCenterY;
  let startPointerDistance = 0;
  let startPointerMidpoint = { x: 0, y: 0 };
  let panStartPointer = { x: 0, y: 0 };
  const activePointers = new Map<number, { x: number; y: number }>();

  const getInteractionRect = () => {
    const shell = getShell();
    if (shell?.classList.contains('is-fullscreen')) {
      return surface.getBoundingClientRect();
    }

    return surface.getBoundingClientRect();
  };

  const getViewportWindow = (currentZoom = zoom) => {
    const rect = getInteractionRect();
    const fitScale = Math.min(rect.width / baseWidth, rect.height / baseHeight);
    const effectiveScale = Math.max(fitScale * currentZoom, Number.EPSILON);

    return {
      rect,
      width: rect.width / effectiveScale,
      height: rect.height / effectiveScale,
    };
  };

  const clampCenter = (
    nextCenterX: number,
    nextCenterY: number,
    nextZoom = zoom
  ) => {
    const viewport = getViewportWindow(nextZoom);
    const viewWidth = viewport.width;
    const viewHeight = viewport.height;
    const minCenterX =
      viewWidth >= baseWidth ? baseCenterX : baseMinX + viewWidth / 2;
    const maxCenterX =
      viewWidth >= baseWidth
        ? baseCenterX
        : baseMinX + baseWidth - viewWidth / 2;
    const minCenterY =
      viewHeight >= baseHeight ? baseCenterY : baseMinY + viewHeight / 2;
    const maxCenterY =
      viewHeight >= baseHeight
        ? baseCenterY
        : baseMinY + baseHeight - viewHeight / 2;

    return {
      x: clamp(nextCenterX, minCenterX, maxCenterX),
      y: clamp(nextCenterY, minCenterY, maxCenterY),
    };
  };

  const applyViewBox = () => {
    const viewport = getViewportWindow(zoom);
    const viewWidth = viewport.width;
    const viewHeight = viewport.height;
    const clampedCenter = clampCenter(centerX, centerY, zoom);
    centerX = clampedCenter.x;
    centerY = clampedCenter.y;

    svg.setAttribute(
      'viewBox',
      `${centerX - viewWidth / 2} ${centerY - viewHeight / 2} ${viewWidth} ${viewHeight}`
    );
  };

  const reset = () => {
    zoom = getDefaultZoom();
    centerX = baseCenterX;
    centerY = baseCenterY;
    applyViewBox();
  };

  const getSvgPoint = (
    clientX: number,
    clientY: number,
    currentCenterX = centerX,
    currentCenterY = centerY,
    currentZoom = zoom
  ) => {
    const viewport = getViewportWindow(currentZoom);
    const rect = viewport.rect;
    const currentWidth = viewport.width;
    const currentHeight = viewport.height;
    return {
      x:
        currentCenterX - currentWidth / 2 + ((clientX - rect.left) / rect.width) * currentWidth,
      y:
        currentCenterY -
        currentHeight / 2 +
        ((clientY - rect.top) / rect.height) * currentHeight,
    };
  };

  const zoomAroundPoint = (
    clientX: number,
    clientY: number,
    nextZoom: number,
    baseZoom = zoom,
    baseCenterXInput = centerX,
    baseCenterYInput = centerY
  ) => {
    const viewport = getViewportWindow(nextZoom);
    const rect = viewport.rect;
    const anchor = getSvgPoint(
      clientX,
      clientY,
      baseCenterXInput,
      baseCenterYInput,
      baseZoom
    );
    const nextWidth = viewport.width;
    const nextHeight = viewport.height;
    const relativeX = (clientX - rect.left) / rect.width;
    const relativeY = (clientY - rect.top) / rect.height;

    return {
      centerX: anchor.x - (relativeX - 0.5) * nextWidth,
      centerY: anchor.y - (relativeY - 0.5) * nextHeight,
    };
  };

  surface.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();

      const nextZoom = clamp(zoom - event.deltaY * 0.0012, 1, getMaxZoom());
      if (nextZoom === zoom) {
        return;
      }

      const nextCenter = zoomAroundPoint(
        event.clientX,
        event.clientY,
        nextZoom
      );

      zoom = nextZoom;
      centerX = nextCenter.centerX;
      centerY = nextCenter.centerY;
      applyViewBox();
    },
    { passive: false }
  );

  const syncGrabState = () => {
    surface.classList.toggle('is-grabbing', activePointers.size > 0);
  };

  const initializePinchGesture = () => {
    const [first, second] = Array.from(activePointers.values());
    if (!first || !second) {
      return;
    }

    gestureStartZoom = zoom;
    gestureStartCenterX = centerX;
    gestureStartCenterY = centerY;
    startPointerDistance = getDistance(first, second);
    startPointerMidpoint = getMidpoint(first, second);
  };

  surface.addEventListener('pointerdown', (event) => {
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    surface.setPointerCapture(event.pointerId);

    if (activePointers.size === 1) {
      gestureStartCenterX = centerX;
      gestureStartCenterY = centerY;
      panStartPointer = { x: event.clientX, y: event.clientY };
    } else if (activePointers.size === 2) {
      initializePinchGesture();
    }

    syncGrabState();
  });

  surface.addEventListener('pointermove', (event) => {
    if (!activePointers.has(event.pointerId)) {
      return;
    }

    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (activePointers.size >= 2) {
      const [first, second] = Array.from(activePointers.values());
      if (!first || !second || !startPointerDistance) {
        return;
      }

      const rect = getInteractionRect();
      const currentDistance = getDistance(first, second);
      const midpoint = getMidpoint(first, second);
      const nextZoom = clamp(
        gestureStartZoom * (currentDistance / startPointerDistance),
        1,
        getMaxZoom()
      );
      const nextCenter = zoomAroundPoint(
        midpoint.x,
        midpoint.y,
        nextZoom,
        gestureStartZoom,
        gestureStartCenterX,
        gestureStartCenterY
      );
      const gestureViewport = getViewportWindow(gestureStartZoom);
      const startWidth = gestureViewport.width;
      const startHeight = gestureViewport.height;
      const deltaMidX =
        ((midpoint.x - startPointerMidpoint.x) / rect.width) * startWidth;
      const deltaMidY =
        ((midpoint.y - startPointerMidpoint.y) / rect.height) * startHeight;

      zoom = nextZoom;
      centerX = nextCenter.centerX - deltaMidX;
      centerY = nextCenter.centerY - deltaMidY;
      applyViewBox();
      return;
    }

    if (activePointers.size === 1) {
      const pointer = activePointers.get(event.pointerId);
      if (!pointer) {
        return;
      }

      const viewport = getViewportWindow(zoom);
      const rect = viewport.rect;
      const currentWidth = viewport.width;
      const currentHeight = viewport.height;
      const deltaX =
        ((pointer.x - panStartPointer.x) / rect.width) * currentWidth;
      const deltaY =
        ((pointer.y - panStartPointer.y) / rect.height) * currentHeight;

      centerX = gestureStartCenterX - deltaX;
      centerY = gestureStartCenterY - deltaY;
      applyViewBox();
    }
  });

  const releasePointer = (event: PointerEvent) => {
    if (!activePointers.has(event.pointerId)) {
      return;
    }

    activePointers.delete(event.pointerId);
    if (surface.hasPointerCapture(event.pointerId)) {
      surface.releasePointerCapture(event.pointerId);
    }

    if (activePointers.size === 1) {
      const [pointer] = Array.from(activePointers.values());
      if (pointer) {
        gestureStartCenterX = centerX;
        gestureStartCenterY = centerY;
        panStartPointer = pointer;
      }
    } else if (activePointers.size >= 2) {
      initializePinchGesture();
    }

    syncGrabState();
  };

  surface.addEventListener('pointerup', releasePointer);
  surface.addEventListener('pointercancel', releasePointer);

  applyViewBox();
  return { reset };
};

for (const [index, block] of diagramBlocks.entries()) {
  const pre = block.matches('pre') ? block : block.querySelector('pre');
  const copyButton = block.querySelector<HTMLButtonElement>('button[data-code]');
  const source =
    copyButton?.dataset.code?.replace(/\u007f/g, '\n').trim() ??
    pre?.innerText?.trim() ??
    pre?.textContent?.trim();
  if (!source || !pre) {
    continue;
  }

  const article = document.querySelector<HTMLElement>('.blog-post');
  const title = article?.dataset.blogTitle ?? 'SAM architecture diagram';

  const wrapper = document.createElement('figure');
  wrapper.className = 'mermaid-shell';

  const chrome = document.createElement('div');
  chrome.className = 'mermaid-chrome';
  chrome.innerHTML = `
    <div>
      <p class="mermaid-eyebrow">Interactive diagram</p>
      <p class="mermaid-hint">Drag to pan. Scroll or pinch to zoom.</p>
    </div>
  `;

  const resetButton = document.createElement('button');
  resetButton.className = 'mermaid-reset';
  resetButton.type = 'button';
  resetButton.textContent = 'Reset view';

  const expandButton = document.createElement('button');
  expandButton.className = 'mermaid-expand';
  expandButton.type = 'button';
  expandButton.textContent = 'Full screen';

  const actions = document.createElement('div');
  actions.className = 'mermaid-actions';
  actions.append(expandButton, resetButton);
  chrome.append(actions);

  const surface = document.createElement('div');
  surface.className = 'mermaid-surface';

  const canvas = document.createElement('div');
  canvas.className = 'mermaid-canvas';
  canvas.innerHTML = `<div class="mermaid">${source}</div>`;
  surface.append(canvas);

  wrapper.append(chrome, surface);
  block.replaceWith(wrapper);

  try {
    const { svg } = await mermaid.render(`sam-diagram-${index}`, source);
    canvas.innerHTML = svg;

    const svgElement = canvas.querySelector<SVGElement>('svg');
    if (!svgElement) {
      continue;
    }

    svgElement.removeAttribute('width');
    svgElement.removeAttribute('height');
    svgElement.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svgElement.setAttribute('role', 'img');
    svgElement.setAttribute('aria-label', `Diagram for ${title}`);
    const controls = attachPanZoom(surface, svgElement);
    resetButton.addEventListener('click', controls.reset);
    expandButton.addEventListener('click', () => {
      wrapper.classList.toggle('is-fullscreen');
      document.body.classList.toggle(
        'mermaid-fullscreen-open',
        wrapper.classList.contains('is-fullscreen')
      );
      expandButton.textContent = wrapper.classList.contains('is-fullscreen')
        ? 'Close full screen'
        : 'Full screen';
      controls.reset();
    });

    wrapper.addEventListener('click', (event) => {
      if (
        wrapper.classList.contains('is-fullscreen') &&
        event.target === wrapper
      ) {
        wrapper.classList.remove('is-fullscreen');
        document.body.classList.remove('mermaid-fullscreen-open');
        expandButton.textContent = 'Full screen';
        controls.reset();
      }
    });
  } catch (error) {
    wrapper.classList.add('mermaid-shell--error');
    surface.innerHTML = `
      <div class="mermaid-error">
        <strong>Mermaid failed to render.</strong>
        <pre>${String(error)}</pre>
      </div>
    `;
  }
}
