import {
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { DEFAULT_VIEWER_MOBILE_BREAKPOINT_PX } from '../constants';
import type { ViewerModel } from '../server/payloads';
import type { ApiClient, Lens, Selection, ViewerState } from './types';

export interface ArchitectureViewerController {
  canvasRef: RefObject<HTMLDivElement | null>;
  closeInspector: () => void;
  drill: (id: string) => void;
  focusId?: string;
  lens: Lens;
  loadModel: () => Promise<void>;
  mobileInspector: boolean;
  mobileViewport: boolean;
  select: (selection: Selection) => void;
  selection?: Selection;
  setLens: Dispatch<SetStateAction<Lens>>;
  setZoom: Dispatch<SetStateAction<number>>;
  viewer: ViewerState;
  zoom: number;
}

export function useArchitectureViewer(api: ApiClient): ArchitectureViewerController {
  const [viewer, setViewer] = useState<ViewerState>(initialViewer);
  const [lens, setLens] = useState<Lens>(readLens);
  const [focusId, setFocusId] = useState<string | undefined>(() => readParam('focus'));
  const [selection, setSelection] = useState<Selection | undefined>(readSelection);
  const [zoom, setZoom] = useState(1);
  const [mobileInspector, setMobileInspector] = useState(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const eventRevisionRef = useRef(0);
  const loadModel = useLoadModel(api, setViewer, setFocusId, setSelection, eventRevisionRef);
  const mobileViewport = useMobileViewport(
    viewer.model?.interaction.mobileBreakpointPx ?? DEFAULT_VIEWER_MOBILE_BREAKPOINT_PX
  );
  useInitialLoad(loadModel, setViewer);
  useEventStream(loadModel, setViewer, eventRevisionRef);
  useUrlState(lens, focusId, selection);
  useEscapeClose(setMobileInspector);
  useDesktopModalReset(mobileViewport, setMobileInspector);
  useFocusReturn(mobileInspector, returnFocusRef);
  const select = (next: Selection) => {
    returnFocusRef.current = activeElement();
    setSelection(next);
    setMobileInspector(mobileViewport);
  };
  const drill = (id: string) => {
    setLens('structure');
    setFocusId(id);
    setSelection({ kind: 'element', id });
  };
  return {
    canvasRef,
    closeInspector: () => setMobileInspector(false),
    drill,
    focusId,
    lens,
    loadModel,
    mobileInspector,
    mobileViewport,
    select,
    selection,
    setLens,
    setZoom,
    viewer,
    zoom,
  };
}

function useLoadModel(
  api: ApiClient,
  setViewer: Dispatch<SetStateAction<ViewerState>>,
  setFocusId: Dispatch<SetStateAction<string | undefined>>,
  setSelection: Dispatch<SetStateAction<Selection | undefined>>,
  eventRevisionRef: MutableRefObject<number>
) {
  const runningRef = useRef<Promise<void> | undefined>(undefined);
  const queuedRef = useRef(false);
  return useCallback(() => {
    if (runningRef.current) {
      queuedRef.current = true;
      return runningRef.current;
    }
    const run = async () => {
      let lastError: unknown;
      do {
        queuedRef.current = false;
        try {
          const eventRevision = eventRevisionRef.current;
          const model = await api.loadModel();
          lastError = undefined;
          setViewer((current) =>
            commitModel(current, model, eventRevision !== eventRevisionRef.current)
          );
          setFocusId((current) => keepId(model, current));
          setSelection((current) => keepSelection(model, current));
        } catch (error) {
          lastError = error;
        }
      } while (queuedRef.current);
      if (lastError) throw lastError;
    };
    const running = run().finally(() => {
      runningRef.current = undefined;
    });
    runningRef.current = running;
    return running;
  }, [api, eventRevisionRef, setFocusId, setSelection, setViewer]);
}

function commitModel(
  current: ViewerState,
  model: ViewerModel,
  preserveNewerEventState: boolean
): ViewerState {
  const invalid =
    model.diagnostics.some((diagnostic) => diagnostic.severity === 'error') ||
    (preserveNewerEventState && current.status.includes('Invalid workspace edit'));
  return {
    ...current,
    loading: false,
    error: undefined,
    model,
    status: invalid
      ? 'Invalid workspace edit detected; keeping last valid model.'
      : current.offline
        ? 'Model refreshed; live updates are reconnecting…'
        : 'Architecture model loaded.',
  };
}

function useInitialLoad(
  loadModel: () => Promise<void>,
  setViewer: Dispatch<SetStateAction<ViewerState>>
): void {
  useEffect(() => {
    void loadModel().catch((error: unknown) => {
      setViewer({
        loading: false,
        error: errorMessage(error),
        status: 'Failed to load model.',
        offline: false,
      });
    });
  }, [loadModel, setViewer]);
}

function useEventStream(
  loadModel: () => Promise<void>,
  setViewer: Dispatch<SetStateAction<ViewerState>>,
  eventRevisionRef: MutableRefObject<number>
): void {
  useEffect(() => {
    const source = new EventSource('/api/events');
    const reload = () => void reloadAfterSse(loadModel, setViewer);
    source.onopen = () => {
      eventRevisionRef.current += 1;
      setViewer((current) => ({
        ...current,
        offline: false,
        status: current.status.includes('Invalid')
          ? current.status
          : current.model
            ? 'Live updates connected.'
            : current.status,
      }));
    };
    source.addEventListener('architecture:model', reload);
    source.addEventListener('architecture:invalid', () => {
      eventRevisionRef.current += 1;
      setViewer((current) => ({
        ...current,
        status: 'Invalid workspace edit detected; keeping last valid model.',
      }));
    });
    source.onerror = () => {
      eventRevisionRef.current += 1;
      setViewer((current) => ({ ...current, offline: true, status: 'SSE reconnecting…' }));
    };
    return () => source.close();
  }, [eventRevisionRef, loadModel, setViewer]);
}

function useUrlState(lens: Lens, focusId?: string, selection?: Selection): void {
  useEffect(() => {
    const params = new URLSearchParams();
    params.set('lens', lens);
    if (focusId) params.set('focus', focusId);
    if (selection) params.set('selected', `${selection.kind}:${selection.id}`);
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
  }, [focusId, lens, selection]);
}

function useEscapeClose(setOpen: Dispatch<SetStateAction<boolean>>): void {
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [setOpen]);
}

function useFocusReturn(open: boolean, returnFocusRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) returnFocusRef.current?.focus();
  }, [open, returnFocusRef]);
}

function useDesktopModalReset(
  mobileViewport: boolean,
  setOpen: Dispatch<SetStateAction<boolean>>
): void {
  useEffect(() => {
    if (!mobileViewport) setOpen(false);
  }, [mobileViewport, setOpen]);
}

async function reloadAfterSse(
  loadModel: () => Promise<void>,
  setViewer: Dispatch<SetStateAction<ViewerState>>
): Promise<void> {
  setViewer((current) => ({ ...current, status: 'Reloading architecture model…', offline: false }));
  try {
    await loadModel();
  } catch (error) {
    setViewer((current) => ({
      ...current,
      offline: true,
      status: `Reload failed: ${errorMessage(error)}`,
    }));
  }
}

function useMobileViewport(breakpointPx: number): boolean {
  const [mobile, setMobile] = useState(() => mediaQuery(breakpointPx).matches);
  useEffect(() => {
    const query = mediaQuery(breakpointPx);
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, [breakpointPx]);
  return mobile;
}

function mediaQuery(breakpointPx: number): MediaQueryList {
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia(`(max-width: ${breakpointPx}px)`);
  }
  return {
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as MediaQueryList;
}

function activeElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

function initialViewer(): ViewerState {
  return { loading: true, status: 'Loading…', offline: false };
}

function readLens(): Lens {
  const value = readParam('lens');
  return value === 'flow' || value === 'state' || value === 'structure' ? value : 'structure';
}

function readSelection(): Selection | undefined {
  const value = readParam('selected');
  const separator = value?.indexOf(':') ?? -1;
  const kind = separator > 0 ? value?.slice(0, separator) : undefined;
  const id = separator > 0 ? value?.slice(separator + 1) : undefined;
  if (!id || !isSelectionKind(kind)) return undefined;
  return { kind, id };
}

function isSelectionKind(kind?: string): kind is Selection['kind'] {
  return (
    kind === 'element' || kind === 'flow' || kind === 'stateMachine' || kind === 'relationship'
  );
}

function readParam(name: string): string | undefined {
  return new URLSearchParams(window.location.search).get(name) ?? undefined;
}

function keepId(model: ViewerModel, id?: string): string | undefined {
  if (!id) return model.summary.roots[0]?.id;
  return model.workspace.elements.some((element) => element.id === id)
    ? id
    : model.summary.roots[0]?.id;
}

function keepSelection(model: ViewerModel, selection?: Selection): Selection | undefined {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error.';
}
