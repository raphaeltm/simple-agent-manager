import { type KeyboardEvent, type RefObject, useCallback, useId, useLayoutEffect, useMemo, useRef } from 'react';
import type uPlot from 'uplot';

import { type ChartTheme, useChartTheme } from './chart-theme';
import { type PanelCallbacks, panelData, type PanelKind, panelOptions, type PanelState } from './panels';
import type { Readout } from './readout';
import type { ViewRange } from './timeline-view';
import { type GestureHandlers, useTimelineGestures } from './useTimelineGestures';
import { useUplot } from './useUplot';

interface PanelSpec {
  kind: PanelKind;
  title: string;
  height: number;
  value: (readout: Readout) => string;
  /** Tool names can be long; this panel lets its value wrap instead of truncating. */
  wrapValue?: boolean;
  legend: (theme: ChartTheme, hasWorkingSet: boolean) => Array<{ color: string; label: string; dashed?: boolean }>;
}

const PANELS: PanelSpec[] = [
  {
    kind: 'cpu',
    title: 'CPU',
    height: 84,
    value: (readout) => readout.cpu,
    legend: (theme) => [{ color: theme.cpu, label: 'cores' }],
  },
  {
    kind: 'memory',
    title: 'Memory',
    height: 84,
    value: (readout) => readout.memory,
    legend: (theme, hasWorkingSet) =>
      hasWorkingSet
        ? [
            { color: theme.memory, label: 'used' },
            { color: theme.memory, label: '+ cache', dashed: true },
          ]
        : [{ color: theme.memory, label: 'incl. cache' }],
  },
  {
    kind: 'disk',
    title: 'Disk',
    height: 60,
    value: (readout) => readout.disk,
    legend: (theme) => [
      { color: theme.ioWrite, label: 'write ↑' },
      { color: theme.ioRead, label: 'read ↓' },
    ],
  },
  {
    kind: 'tools',
    title: 'Tool calls',
    height: 48,
    value: (readout) => readout.tools,
    wrapValue: true,
    legend: () => [],
  },
];

/** Keyboard zoom step: halves or doubles the visible span. */
const KEYBOARD_ZOOM_FACTOR = 2;

interface TimelinePanelsProps {
  state: PanelState;
  readout: Readout;
  cursorX: number | null;
  onCursor: (x: number | null) => void;
  onRange: (min: number, max: number) => void;
  onZoom: (factor: number, anchor: number) => void;
  onResetZoom: () => void;
}

export function TimelinePanels({
  state,
  readout,
  cursorX,
  onCursor,
  onRange,
  onZoom,
  onResetZoom,
}: Readonly<TimelinePanelsProps>) {
  const theme = useChartTheme();
  const syncKey = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const plots = useRef(new Map<PanelKind, RefObject<uPlot | null>>());

  const stateRef = useRef(state);
  /** True while a mouse (not a finger) is over the panels: only then does uPlot's hover drive the cursor. */
  const mouseOverRef = useRef(false);
  const hover = (x: number | null) => {
    if (mouseOverRef.current) onCursor(x);
  };
  const callbacksRef = useRef<PanelCallbacks>({ onHover: hover, onSelectRange: onRange, onResetZoom });
  const gestureRef = useRef<GestureHandlers>({
    plotRect: () => null,
    view: () => ({ min: state.viewMin, max: state.viewMax }),
    onScrub: onCursor,
    onTap: onCursor,
    onRange,
  });
  useLayoutEffect(() => {
    stateRef.current = state;
    callbacksRef.current = { onHover: hover, onSelectRange: onRange, onResetZoom };
    gestureRef.current = {
      plotRect: () => plots.current.get('cpu')?.current?.over.getBoundingClientRect() ?? null,
      view: (): ViewRange => ({ min: state.viewMin, max: state.viewMax }),
      onScrub: onCursor,
      onTap: onCursor,
      onRange,
    };
  });
  useTimelineGestures(wrapperRef, gestureRef);

  // Mirror the React cursor into every panel so touch scrubbing and keyboard moves draw
  // the crosshair. (Mouse hover is already synced by uPlot's own cursor sync group.)
  useLayoutEffect(() => {
    for (const ref of plots.current.values()) {
      const plot = ref.current;
      if (!plot) continue;
      const left = cursorX == null ? -10 : plot.valToPos(cursorX, 'x');
      if (plot.cursor.left !== left) plot.setCursor({ left, top: 10 }, false);
    }
  }, [cursorX, state]);

  const register = useCallback((kind: PanelKind, ref: RefObject<uPlot | null>) => {
    plots.current.set(kind, ref);
  }, []);

  /** Moves the cursor one bucket; stepping past an edge pans the view to follow it. */
  const stepCursor = (from: number, delta: number) => {
    const next = from + delta;
    if (next < state.viewMin || next > state.viewMax) {
      onRange(state.viewMin + delta, state.viewMax + delta);
    }
    onCursor(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const span = state.viewMax - state.viewMin;
    const anchor = cursorX ?? state.viewMin + span / 2;
    const step = state.series.bucketMs;
    const handled: Record<string, () => void> = {
      ArrowLeft: () => stepCursor(anchor, -step),
      ArrowRight: () => stepCursor(anchor, step),
      '+': () => onZoom(1 / KEYBOARD_ZOOM_FACTOR, anchor),
      '=': () => onZoom(1 / KEYBOARD_ZOOM_FACTOR, anchor),
      '-': () => onZoom(KEYBOARD_ZOOM_FACTOR, anchor),
      '0': onResetZoom,
      Escape: () => onCursor(null),
    };
    const action = handled[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };

  return (
    // The panels behave as one slider over time: arrow keys move the instant being read.
    <div
      ref={wrapperRef}
      role="slider"
      tabIndex={0}
      aria-label="Session timeline. Arrow keys move through time; plus and minus zoom; 0 shows the whole session."
      aria-valuemin={Math.round(state.viewMin)}
      aria-valuemax={Math.round(state.viewMax)}
      aria-valuenow={Math.round(cursorX ?? state.viewMin)}
      aria-valuetext={`${readout.time}. CPU ${readout.cpu}. Memory ${readout.memory}. Disk ${readout.disk}. ${readout.tools}.`}
      onKeyDown={onKeyDown}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') mouseOverRef.current = true;
      }}
      onPointerDown={(event) => {
        // A finger takes over from any mouse left resting over the chart (touch laptops).
        if (event.pointerType === 'touch') mouseOverRef.current = false;
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== 'mouse') return;
        mouseOverRef.current = false;
        onCursor(null);
      }}
      className="touch-pan-y select-none rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-focus-ring [&_.u-cursor-x]:border-r-fg-muted [&_.u-select]:bg-accent/15"
    >
      {PANELS.map((panel) => (
        <Panel
          key={panel.kind}
          spec={panel}
          theme={theme}
          syncKey={syncKey}
          state={state}
          stateRef={stateRef}
          callbacksRef={callbacksRef}
          value={panel.value(readout)}
          register={register}
        />
      ))}
    </div>
  );
}

function Panel({
  spec,
  theme,
  syncKey,
  state,
  stateRef,
  callbacksRef,
  value,
  register,
}: Readonly<{
  spec: PanelSpec;
  theme: ChartTheme;
  syncKey: string;
  state: PanelState;
  stateRef: RefObject<PanelState>;
  callbacksRef: RefObject<PanelCallbacks>;
  value: string;
  register: (kind: PanelKind, ref: RefObject<uPlot | null>) => void;
}>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const options = useMemo(
    () => panelOptions(spec.kind, theme, spec.height, syncKey, stateRef, callbacksRef),
    [spec.kind, spec.height, theme, syncKey, stateRef, callbacksRef]
  );
  const data = useMemo(() => panelData(spec.kind, state), [spec.kind, state]);
  const plotRef = useUplot(containerRef, options, data);
  useLayoutEffect(() => register(spec.kind, plotRef), [register, spec.kind, plotRef]);

  return (
    <section aria-label={`${spec.title}: ${value}`} className="mt-1 first:mt-0">
      <div className="flex min-w-0 items-baseline gap-2 px-0.5 text-xs">
        <span className="flex shrink-0 items-center gap-2 font-medium text-fg-primary">
          {spec.title}
          {spec.legend(theme, state.hasWorkingSet).map((item) => (
            <span key={item.label} className="flex items-center gap-1 font-normal text-fg-muted">
              <span
                aria-hidden="true"
                className="inline-block h-0 w-3 border-t-2"
                style={{ borderColor: item.color, borderStyle: item.dashed ? 'dashed' : 'solid' }}
              />
              {item.label}
            </span>
          ))}
        </span>
        <span
          className={`ml-auto min-w-0 text-right tabular-nums text-fg-primary ${spec.wrapValue ? 'line-clamp-2 break-words' : 'truncate'}`}
          title={value}
        >
          {value}
        </span>
      </div>
      <div ref={containerRef} aria-hidden="true" />
    </section>
  );
}
