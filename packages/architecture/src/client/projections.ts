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
  const allChildren = elements.filter((element) => element.parent === parentId);
  const children = allChildren.slice(0, model.limits.children);
  const scopedIds = new Set([parentId, ...children.map((child) => child.id)].filter(Boolean));
  const allRelationships = portalRelationships(model.workspace.relationships, scopedIds);
  return {
    focus,
    breadcrumbs: focus ? breadcrumbs(elements, focus) : [],
    children,
    relationships: allRelationships.slice(0, model.limits.relationships),
    omittedChildren: Math.max(0, allChildren.length - children.length),
    omittedRelationships: Math.max(0, allRelationships.length - model.limits.relationships),
  };
}

export function flowSlice(model: ViewerModel, focusId?: string): FlowSlice {
  const scope = scopedElementIds(model, focusId);
  const allFlows = model.workspace.flows.filter((flow) =>
    flow.steps.some(
      (step) =>
        !focusId ||
        (step.element !== undefined && scope.has(step.element)) ||
        relationshipTouchesScope(model, step.relationship, scope)
    )
  );
  const visible = allFlows.slice(0, model.limits.flows);
  const omittedSteps = visible.reduce(
    (total, flow) => total + Math.max(0, flow.steps.length - model.limits.flowSteps),
    0
  );
  return {
    flows: visible.map((flow) => ({
      ...flow,
      steps: flow.steps.slice(0, model.limits.flowSteps),
    })),
    omittedFlows: Math.max(0, allFlows.length - visible.length),
    omittedSteps,
  };
}

export function stateSlice(model: ViewerModel, focusId?: string): StateSlice {
  const scope = scopedElementIds(model, focusId);
  const allMachines = model.workspace.stateMachines.filter(
    (machine) =>
      !focusId ||
      (machine.element !== undefined && scope.has(machine.element)) ||
      machine.states.some((state) => state.element !== undefined && scope.has(state.element)) ||
      machine.transitions.some((transition) =>
        relationshipTouchesScope(model, transition.relationship, scope)
      )
  );
  const visible = allMachines.slice(0, model.limits.stateMachines);
  return {
    machines: visible.map((machine) => ({
      ...machine,
      states: machine.states.slice(0, model.limits.states),
      transitions: machine.transitions.slice(0, model.limits.transitions),
    })),
    omittedMachines: Math.max(0, allMachines.length - visible.length),
    omittedStates: visible.reduce(
      (total, machine) => total + Math.max(0, machine.states.length - model.limits.states),
      0
    ),
    omittedTransitions: visible.reduce(
      (total, machine) =>
        total + Math.max(0, machine.transitions.length - model.limits.transitions),
      0
    ),
  };
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

export function getRelationship(
  model: ViewerModel,
  id?: string
): ArchitectureRelationship | undefined {
  return model.workspace.relationships.find((relationship) => relationship.id === id);
}

function firstRoot(elements: ArchitectureElement[]): ArchitectureElement | undefined {
  return elements.find((element) => !element.parent) ?? elements[0];
}

function breadcrumbs(
  elements: ArchitectureElement[],
  focus: ArchitectureElement
): ArchitectureElement[] {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const trail: ArchitectureElement[] = [focus];
  const visited = new Set([focus.id]);
  let current = focus.parent ? byId.get(focus.parent) : undefined;
  while (current) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    trail.unshift(current);
    current = current.parent ? byId.get(current.parent) : undefined;
  }
  return trail;
}

function portalRelationships(
  relationships: ArchitectureRelationship[],
  scopedIds: Set<string | undefined>
): ArchitectureRelationship[] {
  return relationships.filter(
    (relationship) => scopedIds.has(relationship.from) || scopedIds.has(relationship.to)
  );
}

function relationshipTouchesScope(
  model: ViewerModel,
  relationshipId: string | undefined,
  scope: Set<string>
): boolean {
  const relationship = getRelationship(model, relationshipId);
  return relationship !== undefined && (scope.has(relationship.from) || scope.has(relationship.to));
}

function scopedElementIds(model: ViewerModel, focusId?: string): Set<string> {
  if (!focusId) return new Set(model.workspace.elements.map((element) => element.id));
  const result = new Set([focusId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const element of model.workspace.elements) {
      if (!element.parent || !result.has(element.parent) || result.has(element.id)) continue;
      result.add(element.id);
      changed = true;
    }
  }
  return result;
}
