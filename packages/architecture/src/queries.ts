import { DEFAULT_QUERY_LIMITS } from './constants';
import type { ArchitectureDiagnostic } from './diagnostics';
import type {
  ArchitectureElement,
  ArchitectureFlow,
  ArchitectureRelationship,
  ArchitectureStateMachine,
  ArchitectureThread,
  SourceRef,
} from './schemas';
import { type ArchitectureTarget, resolveArchitectureTarget } from './targets';
import type { CompiledWorkspace } from './types';

export interface QueryLimits {
  children?: number;
  ancestors?: number;
  incoming?: number;
  outgoing?: number;
  memberships?: number;
  threads?: number;
  sourceRefs?: number;
}

export interface WorkspaceSummary {
  name: string;
  description?: string;
  counts: {
    elements: number;
    relationships: number;
    flows: number;
    stateMachines: number;
    views: number;
    unresolvedThreads: number;
  };
  roots: ArchitectureElement[];
}

export interface ElementDetails {
  element: ArchitectureElement;
  ancestors: ArchitectureElement[];
  children: ArchitectureElement[];
  incoming: ArchitectureRelationship[];
  outgoing: ArchitectureRelationship[];
  flows: ArchitectureFlow[];
  stateMachines: ArchitectureStateMachine[];
  unresolvedThreads: ArchitectureThread[];
  sourceRefs: SourceRef[];
}

export interface InboxItem {
  thread: ArchitectureThread;
  target?: ArchitectureTarget;
}

export function getWorkspaceSummary(workspace: CompiledWorkspace): WorkspaceSummary {
  return {
    name: workspace.manifest.name,
    description: workspace.manifest.description,
    counts: {
      elements: workspace.elements.length,
      relationships: workspace.relationships.length,
      flows: workspace.flows.length,
      stateMachines: workspace.stateMachines.length,
      views: workspace.views.length,
      unresolvedThreads: workspace.threads.filter((thread) => thread.status === 'unresolved')
        .length,
    },
    roots: workspace.elements.filter((element) => !element.parent),
  };
}

export function showElement(
  workspace: CompiledWorkspace,
  elementId: string,
  limits: QueryLimits = {}
): ElementDetails | undefined {
  const element = workspace.indexes.elementsById.get(elementId)?.value;
  if (!element) return undefined;
  const resolvedLimits = { ...DEFAULT_QUERY_LIMITS, ...limits };
  return {
    element,
    ancestors: getAncestors(workspace, element).slice(0, resolvedLimits.ancestors),
    children: (workspace.indexes.childrenByParent.get(element.id) ?? []).slice(
      0,
      resolvedLimits.children
    ),
    incoming: (workspace.indexes.incomingByElement.get(element.id) ?? []).slice(
      0,
      resolvedLimits.incoming
    ),
    outgoing: (workspace.indexes.outgoingByElement.get(element.id) ?? []).slice(
      0,
      resolvedLimits.outgoing
    ),
    flows: flowsForElement(workspace, element.id).slice(0, resolvedLimits.memberships),
    stateMachines: stateMachinesForElement(workspace, element.id).slice(
      0,
      resolvedLimits.memberships
    ),
    unresolvedThreads: workspace.threads
      .filter((thread) => thread.status === 'unresolved' && thread.target === element.id)
      .slice(0, resolvedLimits.threads),
    sourceRefs: (element.sourceRefs ?? []).slice(0, resolvedLimits.sourceRefs),
  };
}

export function listUnresolvedInbox(
  workspace: CompiledWorkspace,
  limit = DEFAULT_QUERY_LIMITS.threads
): InboxItem[] {
  return workspace.threads
    .filter((thread) => thread.status === 'unresolved')
    .sort(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id)
    )
    .slice(0, limit)
    .map((thread) => ({
      thread,
      target: resolveArchitectureTarget(workspace, thread.target),
    }));
}

export function diagnosticsForQueries(workspace: CompiledWorkspace): ArchitectureDiagnostic[] {
  return workspace.threads
    .filter((thread) => !resolveArchitectureTarget(workspace, thread.target))
    .map((thread) => ({
      severity: 'error',
      code: 'dangling-thread-target',
      message: `Thread "${thread.id}" targets missing element "${thread.target}".`,
    }));
}

function getAncestors(
  workspace: CompiledWorkspace,
  element: ArchitectureElement
): ArchitectureElement[] {
  const ancestors: ArchitectureElement[] = [];
  let current = element.parent;
  while (current) {
    const parent = workspace.indexes.elementsById.get(current)?.value;
    if (!parent) break;
    ancestors.unshift(parent);
    current = parent.parent;
  }
  return ancestors;
}

function flowsForElement(workspace: CompiledWorkspace, elementId: string): ArchitectureFlow[] {
  return workspace.flows.filter((flow) =>
    flow.steps.some(
      (step) =>
        step.element === elementId ||
        relationshipTouchesElement(workspace, step.relationship, elementId)
    )
  );
}

function stateMachinesForElement(
  workspace: CompiledWorkspace,
  elementId: string
): ArchitectureStateMachine[] {
  return workspace.stateMachines.filter(
    (machine) =>
      machine.element === elementId ||
      machine.states.some((state) => state.element === elementId) ||
      machine.transitions.some((transition) =>
        relationshipTouchesElement(workspace, transition.relationship, elementId)
      )
  );
}

function relationshipTouchesElement(
  workspace: CompiledWorkspace,
  relationshipId: string | undefined,
  elementId: string
): boolean {
  if (!relationshipId) return false;
  const relationship = workspace.indexes.relationshipsById.get(relationshipId)?.value;
  return relationship?.from === elementId || relationship?.to === elementId;
}
