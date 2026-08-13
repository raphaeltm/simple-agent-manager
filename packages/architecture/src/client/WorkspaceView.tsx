/* eslint-disable jsx-a11y/no-noninteractive-tabindex, jsx-a11y/no-noninteractive-element-interactions -- The scrollable architecture canvas must accept keyboard focus and key events for arrow-key panning. */
import { type KeyboardEvent, type ReactNode } from 'react';

import type { ViewerInteraction, ViewerModel } from '../server/payloads';
import { Inspector } from './Inspector';
import { FlowLens, StateLens, StructureLens } from './Lenses';
import { structureSlice } from './projections';
import type { ApiClient, Lens } from './types';
import type { ArchitectureViewerController } from './useArchitectureViewer';

export function WorkspaceView({
  api,
  controller,
}: {
  api: ApiClient;
  controller: ArchitectureViewerController;
}) {
  const model = controller.viewer.model;
  if (!model) return null;
  const showStatus =
    controller.viewer.offline ||
    controller.viewer.status.includes('Invalid') ||
    controller.viewer.status.includes('failed');
  return (
    <Shell
      mobile={controller.mobileViewport}
      status={`${controller.viewer.status}${controller.viewer.offline ? ' Offline/reconnecting.' : ''}`}
      showStatus={showStatus}
    >
      <WorkspaceHeader controller={controller} model={model} />
      <WorkspaceMain api={api} controller={controller} model={model} />
    </Shell>
  );
}

function WorkspaceHeader({
  controller,
  model,
}: {
  controller: ArchitectureViewerController;
  model: ViewerModel;
}) {
  return (
    <header className="topbar" inert={controller.mobileInspector || undefined}>
      <div>
        <p className="eyebrow">Architecture workspace</p>
        <h1>{model.summary.name}</h1>
      </div>
      <nav aria-label="Architecture lenses" className="lens-tabs">
        {(['structure', 'flow', 'state'] as const).map((lens) => (
          <button
            key={lens}
            type="button"
            aria-current={controller.lens === lens ? 'page' : undefined}
            onClick={() => controller.setLens(lens)}
          >
            {lens[0]?.toUpperCase()}
            {lens.slice(1)}
          </button>
        ))}
      </nav>
    </header>
  );
}

function WorkspaceMain({
  api,
  controller,
  model,
}: {
  api: ApiClient;
  controller: ArchitectureViewerController;
  model: ViewerModel;
}) {
  return (
    <main className="workspace-root">
      <CanvasColumn controller={controller} model={model} />
      {controller.mobileInspector && (
        <button
          type="button"
          aria-label="Close architecture inspector"
          className="inspector-backdrop"
          tabIndex={-1}
          onClick={controller.closeInspector}
        />
      )}
      <Inspector
        api={api}
        model={model}
        selection={controller.selection}
        focusId={controller.focusId}
        mobileOpen={controller.mobileInspector}
        onClose={controller.closeInspector}
        onOpenStructure={controller.drill}
        onReload={controller.loadModel}
      />
    </main>
  );
}

function CanvasColumn({
  controller,
  model,
}: {
  controller: ArchitectureViewerController;
  model: ViewerModel;
}) {
  const breadcrumbs = structureSlice(model, controller.focusId).breadcrumbs;
  return (
    <section
      className="canvas-column"
      aria-hidden={controller.mobileInspector || undefined}
      inert={controller.mobileInspector || undefined}
    >
      <CanvasContext
        controller={controller}
        breadcrumbs={breadcrumbs}
        interaction={model.interaction}
      />
      {controller.lens === 'structure' && (
        <p className="canvas-help" id="canvas-help">
          Zoom with the controls, then pan the focused canvas by scrolling or using arrow keys.
        </p>
      )}
      <LensCanvas controller={controller} model={model} />
    </section>
  );
}

function CanvasContext({
  controller,
  breadcrumbs,
  interaction,
}: {
  controller: ArchitectureViewerController;
  breadcrumbs: Array<{ id: string; title: string }>;
  interaction: ViewerInteraction;
}) {
  return (
    <div className="context-row">
      <nav aria-label="Breadcrumbs">
        {breadcrumbs.map((item) => (
          <button key={item.id} type="button" onClick={() => controller.drill(item.id)}>
            {item.title}
          </button>
        ))}
      </nav>
      {controller.lens === 'structure' && (
        <div className="zoom-controls">
          <button
            type="button"
            onClick={() =>
              controller.setZoom((value) =>
                Math.max(interaction.minZoom, value - interaction.zoomStep)
              )
            }
          >
            Zoom out
          </button>
          <output aria-label="Canvas zoom">{Math.round(controller.zoom * 100)}%</output>
          <button
            type="button"
            onClick={() =>
              controller.setZoom((value) =>
                Math.min(interaction.maxZoom, value + interaction.zoomStep)
              )
            }
          >
            Zoom in
          </button>
          <button type="button" onClick={() => resetCanvas(controller)}>
            Reset view
          </button>
        </div>
      )}
    </div>
  );
}

function LensCanvas({
  controller,
  model,
}: {
  controller: ArchitectureViewerController;
  model: ViewerModel;
}) {
  return (
    <div
      ref={controller.canvasRef}
      className="canvas"
      data-intentional-clip
      aria-describedby={controller.lens === 'structure' ? 'canvas-help' : undefined}
      aria-label={`${controller.lens} architecture canvas`}
      role="region"
      tabIndex={0}
      onKeyDown={(event) => panCanvas(event, controller, model.interaction.panPixels)}
    >
      {model.workspace.elements.length === 0 ? (
        <StateMessage title="Empty architecture workspace" detail="No elements are defined yet." />
      ) : (
        renderLens(controller.lens, controller, model)
      )}
    </div>
  );
}

function renderLens(lens: Lens, controller: ArchitectureViewerController, model: ViewerModel) {
  const props = {
    model,
    focusId: controller.focusId,
    selection: controller.selection,
    zoom: controller.zoom,
    onSelect: controller.select,
    onDrill: controller.drill,
    onLens: controller.setLens as (lens: Lens) => void,
  };
  if (lens === 'flow') return <FlowLens {...props} />;
  if (lens === 'state') return <StateLens {...props} />;
  return <StructureLens {...props} />;
}

function resetCanvas(controller: ArchitectureViewerController): void {
  controller.setZoom(1);
  controller.canvasRef.current?.scrollTo({ left: 0, top: 0 });
}

function panCanvas(
  event: KeyboardEvent<HTMLDivElement>,
  controller: ArchitectureViewerController,
  distance: number
): void {
  const canvas = controller.canvasRef.current;
  if (!canvas) return;
  const offsets: Partial<Record<string, [number, number]>> = {
    ArrowDown: [0, distance],
    ArrowLeft: [-distance, 0],
    ArrowRight: [distance, 0],
    ArrowUp: [0, -distance],
  };
  const offset = offsets[event.key];
  if (!offset) return;
  event.preventDefault();
  canvas.scrollBy({ left: offset[0], top: offset[1] });
}

export function Shell({
  status,
  showStatus = false,
  mobile = false,
  children,
}: {
  status: string;
  showStatus?: boolean;
  mobile?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`architecture-app${mobile ? ' is-mobile' : ''}`}>
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
      {showStatus && (
        <p className="status-banner" role="alert">
          {status}
        </p>
      )}
      {children}
    </div>
  );
}

export function StateMessage({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="state-message">
      <h2>{title}</h2>
      {detail && <p>{detail}</p>}
    </div>
  );
}
