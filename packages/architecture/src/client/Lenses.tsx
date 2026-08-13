import type { CSSProperties } from 'react';

import type { ArchitectureElement, ArchitectureRelationship, FlowStep } from '../schemas';
import type { ViewerModel } from '../server/payloads';
import { flowSlice, type ProjectionIndex, stateSlice, structureSlice } from './projections';
import type { Lens, Selection } from './types';

interface LensProps {
  model: ViewerModel;
  focusId?: string;
  selection?: Selection;
  zoom: number;
  onSelect: (selection: Selection) => void;
  onDrill: (id: string) => void;
  onLens: (lens: Lens) => void;
  projectionIndex: ProjectionIndex;
}

export function StructureLens({
  model,
  focusId,
  selection,
  zoom,
  onSelect,
  onDrill,
  projectionIndex,
}: LensProps) {
  const slice = structureSlice(model, focusId, projectionIndex);
  const { children: childElements, focus, relationships: portals } = slice;
  if (!focus) return <EmptyLens title="No structure" />;
  const style: CSSProperties & Record<'--aw-zoom', string> = { '--aw-zoom': String(zoom) };
  return (
    <div className="structure-lens" style={style}>
      <FocusNode focus={focus} selection={selection} onSelect={onSelect} />
      <ChildNodes
        elements={childElements}
        selection={selection}
        onSelect={onSelect}
        onDrill={onDrill}
      />
      {slice.omittedChildren > 0 && (
        <p className="bounded-note">
          {slice.omittedChildren} additional child records are omitted from this bounded canvas.
        </p>
      )}
      <PortalList portals={portals} selection={selection} onSelect={onSelect} />
      {slice.omittedRelationships > 0 && (
        <p className="bounded-note">
          {slice.omittedRelationships} additional relationships are available through CLI queries.
        </p>
      )}
    </div>
  );
}

function FocusNode({
  focus,
  selection,
  onSelect,
}: {
  focus: ArchitectureElement;
  selection?: Selection;
  onSelect: LensProps['onSelect'];
}) {
  return (
    <button
      type="button"
      className={`${nodeClass(selection, focus.id)} focus-node`}
      aria-pressed={selection?.kind === 'element' && selection.id === focus.id}
      onClick={() => onSelect({ kind: 'element', id: focus.id })}
    >
      <small className="kind-label">Current scope · {focus.kind}</small>
      <span className="node-title">{focus.title}</span>
    </button>
  );
}

function ChildNodes({
  elements,
  selection,
  onSelect,
  onDrill,
}: {
  elements: ArchitectureElement[];
  selection?: Selection;
  onSelect: LensProps['onSelect'];
  onDrill: LensProps['onDrill'];
}) {
  return (
    <div className="node-grid">
      {elements.length === 0 ? (
        <p className="muted">This scope has no direct children.</p>
      ) : (
        elements.map((child) => (
          <article className={nodeClass(selection, child.id)} key={child.id}>
            <button
              type="button"
              className="node-select"
              aria-pressed={selection?.kind === 'element' && selection.id === child.id}
              onClick={() => onSelect({ kind: 'element', id: child.id })}
            >
              <small className="kind-label">{child.kind}</small>
              <span className="node-title">{child.title}</span>
            </button>
            <button
              type="button"
              className="scope-action"
              aria-label={`Open ${child.title} scope`}
              onClick={() => onDrill(child.id)}
            >
              Open scope <span aria-hidden="true">↗</span>
            </button>
          </article>
        ))
      )}
    </div>
  );
}

function PortalList({
  portals,
  selection,
  onSelect,
}: {
  portals: ArchitectureRelationship[];
  selection?: Selection;
  onSelect: LensProps['onSelect'];
}) {
  return (
    <section className="portal-list" aria-label="Cross-scope portal relationships">
      <h3>Portals</h3>
      {portals.length === 0 ? (
        <p className="muted">No cross-scope relationships.</p>
      ) : (
        portals.map((relationship) => (
          <button
            key={relationship.id}
            type="button"
            className="portal-action"
            aria-pressed={selection?.kind === 'relationship' && selection.id === relationship.id}
            onClick={() => onSelect({ kind: 'relationship', id: relationship.id })}
          >
            {relationship.title ?? relationship.id}
          </button>
        ))
      )}
    </section>
  );
}

export function FlowLens({
  model,
  focusId,
  selection,
  onSelect,
  onDrill,
  projectionIndex,
}: LensProps) {
  const slice = flowSlice(model, focusId, projectionIndex);
  if (slice.flows.length === 0) return <EmptyLens title="No flows in this scope" />;
  return (
    <div className="flow-list">
      {slice.flows.map((flow) => (
        <section
          className={`flow-card ${selection?.kind === 'flow' && selection.id === flow.id ? 'selected' : ''}`}
          key={flow.id}
        >
          <header className="flow-card-head">
            <div>
              <p className="eyebrow">Flow</p>
              <h2>
                <button
                  type="button"
                  className="flow-title-action"
                  aria-pressed={selection?.kind === 'flow' && selection.id === flow.id}
                  onClick={() => onSelect({ kind: 'flow', id: flow.id })}
                >
                  {flow.title}
                </button>
              </h2>
            </div>
            <span className="flow-step-count">{flow.steps.length} steps</span>
          </header>
          <ol className="flow-sequence">
            {flow.steps.map((step, index) => (
              <FlowStepItem
                key={step.id}
                index={index}
                step={step}
                projectionIndex={projectionIndex}
                onSelect={onSelect}
                onDrill={onDrill}
              />
            ))}
          </ol>
        </section>
      ))}
      {(slice.omittedFlows > 0 || slice.omittedSteps > 0) && (
        <p className="bounded-note">
          {slice.omittedFlows} additional flows and {slice.omittedSteps} steps are omitted from this
          bounded canvas.
        </p>
      )}
    </div>
  );
}

function FlowStepItem({
  index,
  step,
  projectionIndex,
  onSelect,
  onDrill,
}: {
  index: number;
  step: FlowStep;
  projectionIndex: ProjectionIndex;
  onSelect: (selection: Selection) => void;
  onDrill: (id: string) => void;
}) {
  const element = step.element ? projectionIndex.elementsById.get(step.element) : undefined;
  const relationship = step.relationship
    ? projectionIndex.relationshipsById.get(step.relationship)
    : undefined;
  return (
    <li className="flow-step">
      <span className="flow-step-index" aria-hidden="true">
        {String(index + 1).padStart(2, '0')}
      </span>
      <div className="flow-step-copy">
        <span className="sr-only">Step {index + 1}: </span>
        <p className="flow-step-title">{step.title}</p>
        {(element || relationship) && (
          <div className="flow-step-actions">
            {element && (
              <button
                type="button"
                className="flow-element-action"
                aria-label={`Open ${element.title} in structure`}
                onClick={() => onDrill(element.id)}
              >
                {element.title} <span aria-hidden="true">↗</span>
              </button>
            )}
            {relationship && (
              <button
                type="button"
                className="flow-relationship-action"
                aria-label={`Inspect relationship ${relationship.title ?? relationship.id}`}
                onClick={() => onSelect({ kind: 'relationship', id: relationship.id })}
              >
                via {relationship.title ?? relationship.id}
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

export function StateLens({ model, focusId, selection, onSelect, projectionIndex }: LensProps) {
  const slice = stateSlice(model, focusId, projectionIndex);
  if (slice.machines.length === 0) return <EmptyLens title="No state machines in this scope" />;
  return (
    <div className="state-list">
      {slice.machines.map((machine) => (
        <section className="state-card" key={machine.id}>
          <button
            type="button"
            className={machine.id === selection?.id ? 'selected text-row' : 'text-row'}
            aria-pressed={selection?.kind === 'stateMachine' && selection.id === machine.id}
            onClick={() => onSelect({ kind: 'stateMachine', id: machine.id })}
          >
            {machine.title}
          </button>
          <div className="state-rail">
            {machine.states.map((state) => (
              <span key={state.id}>{state.title}</span>
            ))}
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
      {(slice.omittedMachines > 0 || slice.omittedStates > 0 || slice.omittedTransitions > 0) && (
        <p className="bounded-note">
          {slice.omittedMachines} machines, {slice.omittedStates} states, and{' '}
          {slice.omittedTransitions} transitions are omitted from this bounded canvas.
        </p>
      )}
    </div>
  );
}

function EmptyLens({ title }: { title: string }) {
  return (
    <div className="empty-lens">
      <h2>{title}</h2>
      <p>Add matching architecture records to populate this lens.</p>
    </div>
  );
}

function nodeClass(selection: Selection | undefined, id: string): string {
  return selection?.kind === 'element' && selection.id === id ? 'arch-node selected' : 'arch-node';
}
