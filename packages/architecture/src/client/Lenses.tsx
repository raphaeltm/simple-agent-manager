import type { ViewerModel } from '../server/payloads';
import type { Lens, Selection } from './types';

interface LensProps {
  model: ViewerModel;
  focusId?: string;
  selection?: Selection;
  zoom: number;
  onSelect: (selection: Selection) => void;
  onDrill: (id: string) => void;
  onLens: (lens: Lens) => void;
}

export function StructureLens({ model, focusId, selection, zoom, onSelect, onDrill }: LensProps) {
  const focus = model.workspace.elements.find((element) => element.id === focusId) ?? model.summary.roots[0];
  const children = model.workspace.elements.filter((element) => element.parent === focus?.id);
  const scopedIds = new Set([focus?.id, ...children.map((child) => child.id)].filter(Boolean));
  const portals = model.workspace.relationships.filter((relationship) =>
    scopedIds.has(relationship.from) || scopedIds.has(relationship.to)
  );
  if (!focus) return <EmptyLens title="No structure" />;
  const style: CSSProperties & Record<'--aw-zoom', string> = { '--aw-zoom': String(zoom) };
  return (
    <div className="structure-lens" style={style}>
      <button type="button" className={nodeClass(selection, focus.id)} onClick={() => onSelect({ kind: 'element', id: focus.id })}>
        <span>{focus.title}</span>
        <small>{focus.kind}</small>
      </button>
      <div className="node-grid">
        {children.length === 0 ? <p className="muted">This scope has no direct children.</p> : children.map((child) => (
          <article className={nodeClass(selection, child.id)} key={child.id}>
            <button type="button" onClick={() => onSelect({ kind: 'element', id: child.id })}>
              <span>{child.title}</span>
              <small>{child.kind}</small>
            </button>
            <button type="button" className="secondary" onClick={() => onDrill(child.id)}>Drill into</button>
          </article>
        ))}
      </div>
      <section className="portal-list" aria-label="Cross-scope portal relationships">
        <h3>Portals</h3>
        {portals.length === 0 ? <p className="muted">No cross-scope relationships.</p> : portals.map((relationship) => (
          <button key={relationship.id} type="button" onClick={() => onSelect({ kind: 'relationship', id: relationship.id })}>
            {relationship.title ?? relationship.id}
          </button>
        ))}
      </section>
    </div>
  );
}

export function FlowLens({ model, focusId, selection, onSelect, onDrill }: LensProps) {
  const flows = model.workspace.flows.filter((flow) =>
    !focusId || flow.steps.some((step) => step.element === focusId || relationshipTouches(model, step.relationship, focusId))
  );
  const visibleFlows = flows.length > 0 ? flows : model.workspace.flows;
  if (visibleFlows.length === 0) return <EmptyLens title="No flows in this scope" />;
  return (
    <div className="flow-list">
      {visibleFlows.map((flow) => (
        <section className="flow-card" key={flow.id}>
          <button type="button" className={flow.id === selection?.id ? 'selected text-row' : 'text-row'} onClick={() => onSelect({ kind: 'flow', id: flow.id })}>
            {flow.title}
          </button>
          <ol>
            {flow.steps.map((step) => (
              <FlowStepItem key={step.id} flowId={flow.id} title={step.title} element={step.element} onSelect={onSelect} onDrill={onDrill} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function FlowStepItem({ flowId, title, element, onSelect, onDrill }: {
  flowId: string;
  title: string;
  element?: string;
  onSelect: (selection: Selection) => void;
  onDrill: (id: string) => void;
}) {
  return (
    <li>
      <button type="button" onClick={() => onSelect({ kind: 'flow', id: flowId })}>{title}</button>
      {element && <button type="button" className="secondary" onClick={() => onDrill(element)}>Open in structure</button>}
    </li>
  );
}

export function StateLens({ model, focusId, selection, onSelect }: LensProps) {
  const machines = model.workspace.stateMachines.filter((machine) =>
    !focusId ||
    machine.element === focusId ||
    machine.states.some((state) => state.element === focusId) ||
    machine.transitions.some((transition) => relationshipTouches(model, transition.relationship, focusId))
  );
  const visibleMachines = machines.length > 0 ? machines : model.workspace.stateMachines;
  if (visibleMachines.length === 0) return <EmptyLens title="No state machines in this scope" />;
  return (
    <div className="state-list">
      {visibleMachines.map((machine) => (
        <section className="state-card" key={machine.id}>
          <button type="button" className={machine.id === selection?.id ? 'selected text-row' : 'text-row'} onClick={() => onSelect({ kind: 'stateMachine', id: machine.id })}>
            {machine.title}
          </button>
          <div className="state-rail">
            {machine.states.map((state) => <span key={state.id}>{state.title}</span>)}
          </div>
          <ul aria-label={`${machine.title} transition list`}>
            {machine.transitions.map((transition, index) => (
              <li key={`${transition.from}-${transition.to}-${index}`}>
                {transition.from} → {transition.to}
                {transition.event ? ` when ${transition.event}` : ''}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function EmptyLens({ title }: { title: string }) {
  return <div className="empty-lens"><h2>{title}</h2><p>Add matching architecture records to populate this lens.</p></div>;
}

function nodeClass(selection: Selection | undefined, id: string): string {
  return selection?.kind === 'element' && selection.id === id ? 'arch-node selected' : 'arch-node';
}

function relationshipTouches(model: ViewerModel, relationshipId: string | undefined, elementId: string): boolean {
  const relationship = model.workspace.relationships.find((item) => item.id === relationshipId);
  return relationship?.from === elementId || relationship?.to === elementId;
}
import type { CSSProperties } from 'react';
