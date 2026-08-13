import type {
  ArchitectureElement,
  ArchitectureFlow,
  ArchitectureRelationship,
  ArchitectureStateMachine,
} from '../schemas';
import type { ViewerModel } from '../server/payloads';
import type { FlowSlice, StateSlice, StructureSlice } from './types';

export interface ProjectionIndex {
  childrenByParent: Map<string, ArchitectureElement[]>;
  elementsById: Map<string, ArchitectureElement>;
  flowsById: Map<string, ArchitectureFlow>;
  machinesById: Map<string, ArchitectureStateMachine>;
  relationshipsByElement: Map<string, ArchitectureRelationship[]>;
  relationshipsById: Map<string, ArchitectureRelationship>;
  relationshipOrder: Map<string, number>;
}

export function createProjectionIndex(model: ViewerModel): ProjectionIndex {
  const childrenByParent = new Map<string, ArchitectureElement[]>();
  const relationshipsByElement = new Map<string, ArchitectureRelationship[]>();
  for (const element of model.workspace.elements) {
    if (!element.parent) continue;
    const children = childrenByParent.get(element.parent) ?? [];
    children.push(element);
    childrenByParent.set(element.parent, children);
  }
  for (const relationship of model.workspace.relationships) {
    for (const elementId of new Set([relationship.from, relationship.to])) {
      const relationships = relationshipsByElement.get(elementId) ?? [];
      relationships.push(relationship);
      relationshipsByElement.set(elementId, relationships);
    }
  }
  return {
    childrenByParent,
    elementsById: new Map(model.workspace.elements.map((element) => [element.id, element])),
    flowsById: new Map(model.workspace.flows.map((flow) => [flow.id, flow])),
    machinesById: new Map(model.workspace.stateMachines.map((machine) => [machine.id, machine])),
    relationshipsByElement,
    relationshipsById: new Map(
      model.workspace.relationships.map((relationship) => [relationship.id, relationship])
    ),
    relationshipOrder: new Map(
      model.workspace.relationships.map((relationship, index) => [relationship.id, index])
    ),
  };
}

export function structureSlice(
  model: ViewerModel,
  focusId?: string,
  index = createProjectionIndex(model)
): StructureSlice {
  const elements = model.workspace.elements;
  const focus = focusId ? index.elementsById.get(focusId) : firstRoot(elements);
  const parentId = focus?.id;
  const allChildren = parentId ? (index.childrenByParent.get(parentId) ?? []) : [];
  const children = allChildren.slice(0, model.limits.children);
  const scopedIds = new Set([parentId, ...children.map((child) => child.id)].filter(Boolean));
  const allRelationships = portalRelationships(index, scopedIds);
  const allBreadcrumbs = focus ? breadcrumbs(index.elementsById, focus) : [];
  const visibleBreadcrumbs = boundBreadcrumbs(allBreadcrumbs, model.limits.breadcrumbs);
  return {
    focus,
    breadcrumbs: visibleBreadcrumbs,
    omittedBreadcrumbs: allBreadcrumbs.length - visibleBreadcrumbs.length,
    children,
    relationships: allRelationships.slice(0, model.limits.relationships),
    omittedChildren: Math.max(0, allChildren.length - children.length),
    omittedRelationships: Math.max(0, allRelationships.length - model.limits.relationships),
  };
}

function boundBreadcrumbs(
  breadcrumbs: ArchitectureElement[],
  limit: number
): ArchitectureElement[] {
  if (breadcrumbs.length <= limit) return breadcrumbs;
  if (limit <= 1) return breadcrumbs.slice(-1);
  const root = breadcrumbs[0];
  return root ? [root, ...breadcrumbs.slice(-(limit - 1))] : [];
}

export function flowSlice(
  model: ViewerModel,
  focusId?: string,
  index = createProjectionIndex(model)
): FlowSlice {
  const scope = scopedElementIds(model, focusId, index);
  const allFlows = model.workspace.flows.filter((flow) =>
    flow.steps.some(
      (step) =>
        !focusId ||
        (step.element !== undefined && scope.has(step.element)) ||
        relationshipTouchesScope(index, step.relationship, scope)
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

export function stateSlice(
  model: ViewerModel,
  focusId?: string,
  index = createProjectionIndex(model)
): StateSlice {
  const scope = scopedElementIds(model, focusId, index);
  const allMachines = model.workspace.stateMachines.filter(
    (machine) =>
      !focusId ||
      (machine.element !== undefined && scope.has(machine.element)) ||
      machine.states.some((state) => state.element !== undefined && scope.has(state.element)) ||
      machine.transitions.some((transition) =>
        relationshipTouchesScope(index, transition.relationship, scope)
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
  byId: Map<string, ArchitectureElement>,
  focus: ArchitectureElement
): ArchitectureElement[] {
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
  index: ProjectionIndex,
  scopedIds: Set<string | undefined>
): ArchitectureRelationship[] {
  const relationships = new Map<string, ArchitectureRelationship>();
  for (const elementId of scopedIds) {
    if (!elementId) continue;
    for (const relationship of index.relationshipsByElement.get(elementId) ?? []) {
      relationships.set(relationship.id, relationship);
    }
  }
  return [...relationships.values()].sort(
    (left, right) =>
      (index.relationshipOrder.get(left.id) ?? 0) - (index.relationshipOrder.get(right.id) ?? 0)
  );
}

function relationshipTouchesScope(
  index: ProjectionIndex,
  relationshipId: string | undefined,
  scope: Set<string>
): boolean {
  const relationship = relationshipId ? index.relationshipsById.get(relationshipId) : undefined;
  return relationship !== undefined && (scope.has(relationship.from) || scope.has(relationship.to));
}

function scopedElementIds(
  model: ViewerModel,
  focusId: string | undefined,
  index: ProjectionIndex
): Set<string> {
  if (!focusId) return new Set(model.workspace.elements.map((element) => element.id));
  const result = new Set([focusId]);
  const queue = [focusId];
  while (queue.length > 0) {
    const parentId = queue.shift();
    if (!parentId) continue;
    for (const element of index.childrenByParent.get(parentId) ?? []) {
      if (result.has(element.id)) continue;
      result.add(element.id);
      queue.push(element.id);
    }
  }
  return result;
}
