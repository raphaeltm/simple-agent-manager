/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The scrollable architecture canvas must accept keyboard focus for arrow-key panning. */
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { createApiClient } from './api';
import { Inspector } from './Inspector';
import { FlowLens, StateLens, StructureLens } from './Lenses';
import { structureSlice } from './projections';
import type { Lens, Selection, ViewerState } from './types';

const DEFAULT_LENS: Lens = 'structure';
const MIN_ZOOM = 0.75;
const MAX_ZOOM = 1.5;
const ZOOM_STEP = 0.125;

export function App() {
  const api = useMemo(() => createApiClient(), []);
  const [viewer, setViewer] = useState<ViewerState>({
    loading: true,
    status: 'Loading…',
    offline: false,
  });
  const [lens, setLens] = useState<Lens>(() => readLens());
  const [focusId, setFocusId] = useState<string | undefined>(() => readParam('focus'));
  const [selection, setSelection] = useState<Selection | undefined>(() => readSelection());
  const [zoom, setZoom] = useState(1);
  const [mobileInspector, setMobileInspector] = useState(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const loadModel = useCallback(async () => {
    const model = await api.loadModel();
    setViewer({ loading: false, model, status: 'Architecture model loaded.', offline: false });
    setFocusId((current) => keepId(model, current));
    setSelection((current) => keepSelection(model, current));
  }, [api]);

  useEffect(() => {
    void loadModel().catch((error: unknown) => {
      setViewer({
        loading: false,
        error: message(error),
        status: 'Failed to load model.',
        offline: false,
      });
    });
  }, [loadModel]);

  useEffect(() => {
    const source = new EventSource('/api/events');
    source.onmessage = () => void reloadAfterSse(loadModel, setViewer);
    source.addEventListener('architecture:model', () => void reloadAfterSse(loadModel, setViewer));
    source.addEventListener(
      'architecture:threads',
      () => void reloadAfterSse(loadModel, setViewer)
    );
    source.addEventListener('architecture:invalid', () => {
      setViewer((current) => ({
        ...current,
        status: 'Invalid workspace edit detected; keeping last valid model.',
      }));
    });
    source.onerror = () => {
      setViewer((current) => ({ ...current, offline: true, status: 'SSE reconnecting…' }));
    };
    return () => source.close();
  }, [loadModel]);

  useEffect(() => {
    const params = new URLSearchParams();
    params.set('lens', lens);
    if (focusId) params.set('focus', focusId);
    if (selection) params.set('selected', `${selection.kind}:${selection.id}`);
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
  }, [focusId, lens, selection]);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setMobileInspector(false);
      returnFocusRef.current?.focus();
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);

  const breadcrumbs = viewer.model ? structureSlice(viewer.model, focusId).breadcrumbs : [];
  const select = (next: Selection) => {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelection(next);
    setMobileInspector(true);
  };
  const closeInspector = () => {
    setMobileInspector(false);
    returnFocusRef.current?.focus();
  };
  const drill = (id: string) => {
    setLens('structure');
    setFocusId(id);
    setSelection({ kind: 'element', id });
  };

  if (viewer.loading)
    return (
      <Shell status={viewer.status}>
        <StateMessage title="Loading architecture workspace" />
      </Shell>
    );
  if (viewer.error || !viewer.model)
    return (
      <Shell status={viewer.status}>
        <StateMessage title="Invalid workspace" detail={viewer.error} />
      </Shell>
    );
  const model = viewer.model;
  const empty = model.workspace.elements.length === 0;

  return (
    <Shell status={`${viewer.status}${viewer.offline ? ' Offline/reconnecting.' : ''}`}>
      <header className="topbar">
        <div>
          <p className="eyebrow">Architecture workspace</p>
          <h1>{model.summary.name}</h1>
        </div>
        <nav aria-label="Architecture lenses" className="lens-tabs">
          {(['structure', 'flow', 'state'] as const).map((item) => (
            <button
              key={item}
              type="button"
              aria-current={lens === item ? 'page' : undefined}
              onClick={() => setLens(item)}
            >
              {item[0]?.toUpperCase()}
              {item.slice(1)}
            </button>
          ))}
        </nav>
      </header>
      <main className="workspace-root">
        <section className="canvas-column">
          <div className="context-row">
            <nav aria-label="Breadcrumbs">
              {breadcrumbs.map((item) => (
                <button key={item.id} type="button" onClick={() => drill(item.id)}>
                  {item.title}
                </button>
              ))}
            </nav>
            <div className="zoom-controls">
              <button
                type="button"
                onClick={() => setZoom((value) => Math.max(MIN_ZOOM, value - ZOOM_STEP))}
              >
                Zoom out
              </button>
              <output aria-label="Canvas zoom">{Math.round(zoom * 100)}%</output>
              <button
                type="button"
                onClick={() => setZoom((value) => Math.min(MAX_ZOOM, value + ZOOM_STEP))}
              >
                Zoom in
              </button>
              <button
                type="button"
                onClick={() => {
                  setZoom(1);
                  canvasRef.current?.scrollTo({ left: 0, top: 0 });
                }}
              >
                Reset view
              </button>
            </div>
          </div>
          <p className="canvas-help" id="canvas-help">
            Zoom with the controls, then pan the focused canvas by scrolling or using arrow keys.
          </p>
          <div
            ref={canvasRef}
            className="canvas"
            data-intentional-clip
            aria-describedby="canvas-help"
            aria-label={`${lens} architecture canvas`}
            role="region"
            tabIndex={0}
          >
            {empty ? (
              <StateMessage
                title="Empty architecture workspace"
                detail="No elements are defined yet."
              />
            ) : (
              renderLens(lens, model, focusId, selection, zoom, select, drill, setLens)
            )}
          </div>
        </section>
        <Inspector
          api={api}
          model={model}
          selection={selection}
          focusId={focusId}
          mobileOpen={mobileInspector}
          onClose={closeInspector}
          onOpenStructure={drill}
          onReload={loadModel}
        />
      </main>
    </Shell>
  );
}

function Shell({ status, children }: { status: string; children: ReactNode }) {
  return (
    <div className="architecture-app">
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
      {children}
    </div>
  );
}

function StateMessage({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="state-message">
      <h2>{title}</h2>
      {detail && <p>{detail}</p>}
    </div>
  );
}

function renderLens(
  lens: Lens,
  model: NonNullable<ViewerState['model']>,
  focusId: string | undefined,
  selection: Selection | undefined,
  zoom: number,
  onSelect: (selection: Selection) => void,
  onDrill: (id: string) => void,
  onLens: (lens: Lens) => void
) {
  const props = { model, focusId, selection, zoom, onSelect, onDrill, onLens };
  if (lens === 'flow') return <FlowLens {...props} />;
  if (lens === 'state') return <StateLens {...props} />;
  return <StructureLens {...props} />;
}

async function reloadAfterSse(
  loadModel: () => Promise<void>,
  setViewer: Dispatch<SetStateAction<ViewerState>>
) {
  setViewer((current) => ({ ...current, status: 'Reloading architecture model…', offline: false }));
  await loadModel();
}

function readLens(): Lens {
  const value = readParam('lens');
  return value === 'flow' || value === 'state' || value === 'structure' ? value : DEFAULT_LENS;
}

function readSelection(): Selection | undefined {
  const value = readParam('selected');
  const separator = value?.indexOf(':') ?? -1;
  const kind = separator > 0 ? value?.slice(0, separator) : undefined;
  const id = separator > 0 ? value?.slice(separator + 1) : undefined;
  if (
    !id ||
    (kind !== 'element' && kind !== 'flow' && kind !== 'stateMachine' && kind !== 'relationship')
  )
    return undefined;
  return { kind, id };
}

function readParam(name: string): string | undefined {
  const value = new URLSearchParams(window.location.search).get(name);
  return value ?? undefined;
}

function keepId(
  model: NonNullable<ViewerState['model']>,
  id: string | undefined
): string | undefined {
  if (!id) return model.summary.roots[0]?.id;
  return model.workspace.elements.some((element) => element.id === id)
    ? id
    : model.summary.roots[0]?.id;
}

function keepSelection(
  model: NonNullable<ViewerState['model']>,
  selection: Selection | undefined
): Selection | undefined {
  if (!selection) return undefined;
  const records = {
    element: model.workspace.elements,
    flow: model.workspace.flows,
    relationship: model.workspace.relationships,
    stateMachine: model.workspace.stateMachines,
    thread: model.workspace.threads,
  };
  return records[selection.kind].some((record) => record.id === selection.id)
    ? selection
    : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error.';
}
