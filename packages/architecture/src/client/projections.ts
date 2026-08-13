import type {
  ArchitectureElement,
  ArchitectureFlow,
  ArchitectureRelationship,
  ArchitectureStateMachine,
} from '../schemas';
import type { ViewerModel } from '../server/payloads';
import type { FlowSlice, StateSlice, StructureSlice } from './types';

export function structureSlice(model: ViewerModel, focusId?: string): StructureSlice {
  const elements = model.workspace.elements;
  const focus = focusId ? elements.find((element) => element.id === focusId) : firstRoot(elements);
  const parentId = focus?.id;
  const children = elements.filter((element) => element.parent === parentId);
  const scopedIds = new Set([parentId, ...children.map((child) => child.id)].filter(Boolean));
  return {
    focus,
    breadcrumbs: focus ? breadcrumbs(elements, focus) : [],
    children,
    relationships: portalRelationships(model.workspace.relationships, scopedIds),
  };
}

export function flowSlice(model: ViewerModel, focusId?: string): FlowSlice {
  const flows = model.workspace.flows.filter((flow) =>
    !focusId || flow.steps.some((step) => step.element === focusId || relationshipTouches(model, step.relationship, focusId))
  );
  return { flows: flows.length > 0 ? flows : model.workspace.flows };
}

export function stateSlice(model: ViewerModel, focusId?: string): StateSlice {
  const machines = model.workspace.stateMachines.filter((machine) =>
    !focusId ||
    machine.element === focusId ||
    machine.states.some((state) => state.element === focusId) ||
    machine.transitions.some((transition) => relationshipTouches(model, transition.relationship, focusId))
  );
  return { machines: machines.length > 0 ? machines : model.workspace.stateMachines };
}

export function getElement(model: ViewerModel, id?: string): ArchitectureElement | undefined {
  return model.workspace.elements.find((element) => element.id === id);
}

export function getFlow(model: ViewerModel, id?: string): ArchitectureFlow | undefined {
  return model.workspace.flows.find((flow) => flow.id === id);
}

export function getMachine(model: ViewerModel, id?: string): ArchitectureStateMachine | undefined {
  return model.workspace.stateMachines.find((machine) => machine.id === id);
}

export function getRelationship(model: ViewerModel, id?: string): ArchitectureRelationship | undefined {
  return model.workspace.relationships.find((relationship) => relationship.id === id);
}

function firstRoot(elements: ArchitectureElement[]): ArchitectureElement | undefined {
  return elements.find((element) => !element.parent) ?? elements[0];
}

function breadcrumbs(elements: ArchitectureElement[], focus: ArchitectureElement): ArchitectureElement[] {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const trail: ArchitectureElement[] = [focus];
  let current = focus.parent ? byId.get(focus.parent) : undefined;
  while (current) {
    trail.unshift(current);
    current = current.parent ? byId.get(current.parent) : undefined;
  }
  return trail;
}

function portalRelationships(
  relationships: ArchitectureRelationship[],
  scopedIds: Set<string | undefined>
): ArchitectureRelationship[] {
  return relationships.filter((relationship) => scopedIds.has(relationship.from) || scopedIds.has(relationship.to));
}

function relationshipTouches(model: ViewerModel, relationshipId: string | undefined, elementId: string): boolean {
  const relationship = getRelationship(model, relationshipId);
  return relationship?.from === elementId || relationship?.to === elementId;
}
