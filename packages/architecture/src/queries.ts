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
  roots?: number;
  children?: number;
  ancestors?: number;
  incoming?: number;
  outgoing?: number;
  memberships?: number;
  threads?: number;
  sourceRefs?: number;
  tags?: number;
  flowSteps?: number;
  states?: number;
  transitions?: number;
  threadMessages?: number;
  textChars?: number;
}

export interface BoundedFlow extends Omit<ArchitectureFlow, 'steps' | 'sourceRefs' | 'metadata'> {
  steps: ArchitectureFlow['steps'];
  sourceRefs?: SourceRef[];
  truncated: { steps: number; sourceRefs: number };
}

export interface BoundedStateMachine extends Omit<
  ArchitectureStateMachine,
  'states' | 'transitions' | 'sourceRefs' | 'metadata'
> {
  states: ArchitectureStateMachine['states'];
  transitions: ArchitectureStateMachine['transitions'];
  sourceRefs?: SourceRef[];
  truncated: { states: number; transitions: number; sourceRefs: number };
}

export interface BoundedThread extends Omit<ArchitectureThread, 'messages' | 'sourceRefs'> {
  messages: ArchitectureThread['messages'];
  sourceRefs?: SourceRef[];
  truncated: { messages: number; sourceRefs: number };
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
  truncated: { roots: number };
}

export interface ElementDetails {
  element: ArchitectureElement;
  ancestors: ArchitectureElement[];
  children: ArchitectureElement[];
  incoming: ArchitectureRelationship[];
  outgoing: ArchitectureRelationship[];
  flows: BoundedFlow[];
  stateMachines: BoundedStateMachine[];
  unresolvedThreads: BoundedThread[];
  sourceRefs: SourceRef[];
  truncated: {
    ancestors: number;
    children: number;
    incoming: number;
    outgoing: number;
    flows: number;
    stateMachines: number;
    threads: number;
    sourceRefs: number;
  };
}

export interface InboxItem {
  thread: BoundedThread;
  target?: ArchitectureTarget;
}

/** Return a layout-free workspace overview bounded by the supplied limits. */
export function getWorkspaceSummary(
  workspace: CompiledWorkspace,
  limits: QueryLimits = {}
): WorkspaceSummary {
  const resolvedLimits = resolveQueryLimits(limits);
  const roots = workspace.elements.filter((element) => !element.parent);
  return {
    name: boundText(workspace.manifest.name, resolvedLimits.textChars),
    description: boundOptionalText(workspace.manifest.description, resolvedLimits.textChars),
    counts: {
      elements: workspace.elements.length,
      relationships: workspace.relationships.length,
      flows: workspace.flows.length,
      stateMachines: workspace.stateMachines.length,
      views: workspace.views.length,
      unresolvedThreads: workspace.threads.filter((thread) => thread.status === 'unresolved')
        .length,
    },
    roots: roots
      .slice(0, resolvedLimits.roots)
      .map((element) => boundElement(element, resolvedLimits)),
    truncated: { roots: omittedCount(roots.length, resolvedLimits.roots) },
  };
}

/** Return a bounded semantic neighborhood for one element ID. */
export function showElement(
  workspace: CompiledWorkspace,
  elementId: string,
  limits: QueryLimits = {}
): ElementDetails | undefined {
  const element = workspace.indexes.elementsById.get(elementId)?.value;
  if (!element) return undefined;
  const resolvedLimits = resolveQueryLimits(limits);
  const ancestors = getAncestors(workspace, element);
  const children = workspace.indexes.childrenByParent.get(element.id) ?? [];
  const incoming = workspace.indexes.incomingByElement.get(element.id) ?? [];
  const outgoing = workspace.indexes.outgoingByElement.get(element.id) ?? [];
  const flows = flowsForElement(workspace, element.id);
  const stateMachines = stateMachinesForElement(workspace, element.id);
  const unresolvedThreads = workspace.threads.filter(
    (thread) => thread.status === 'unresolved' && thread.target === element.id
  );
  const sourceRefs = element.sourceRefs ?? [];
  return {
    element: boundElement(element, resolvedLimits),
    ancestors: ancestors
      .slice(0, resolvedLimits.ancestors)
      .map((item) => boundElement(item, resolvedLimits)),
    children: children
      .slice(0, resolvedLimits.children)
      .map((item) => boundElement(item, resolvedLimits)),
    incoming: incoming
      .slice(0, resolvedLimits.incoming)
      .map((item) => boundRelationship(item, resolvedLimits)),
    outgoing: outgoing
      .slice(0, resolvedLimits.outgoing)
      .map((item) => boundRelationship(item, resolvedLimits)),
    flows: flows
      .slice(0, resolvedLimits.memberships)
      .map((item) => boundFlow(item, resolvedLimits)),
    stateMachines: stateMachines
      .slice(0, resolvedLimits.memberships)
      .map((item) => boundStateMachine(item, resolvedLimits)),
    unresolvedThreads: unresolvedThreads
      .slice(0, resolvedLimits.threads)
      .map((item) => boundThread(item, resolvedLimits)),
    sourceRefs: boundSourceRefs(sourceRefs, resolvedLimits) ?? [],
    truncated: {
      ancestors: omittedCount(ancestors.length, resolvedLimits.ancestors),
      children: omittedCount(children.length, resolvedLimits.children),
      incoming: omittedCount(incoming.length, resolvedLimits.incoming),
      outgoing: omittedCount(outgoing.length, resolvedLimits.outgoing),
      flows: omittedCount(flows.length, resolvedLimits.memberships),
      stateMachines: omittedCount(stateMachines.length, resolvedLimits.memberships),
      threads: omittedCount(unresolvedThreads.length, resolvedLimits.threads),
      sourceRefs: omittedCount(sourceRefs.length, resolvedLimits.sourceRefs),
    },
  };
}

/** Return the oldest unresolved thread items up to the requested limit. */
export function listUnresolvedInbox(
  workspace: CompiledWorkspace,
  limit = DEFAULT_QUERY_LIMITS.threads,
  limits: QueryLimits = {}
): InboxItem[] {
  const resolvedLimits = resolveQueryLimits({ ...limits, threads: limit });
  return workspace.threads
    .filter((thread) => thread.status === 'unresolved')
    .sort(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id)
    )
    .slice(0, limit)
    .map((thread) => {
      const target = resolveArchitectureTarget(workspace, thread.target);
      return {
        thread: boundThread(thread, resolvedLimits),
        target: target
          ? {
              ...target,
              id: boundText(target.id, resolvedLimits.textChars),
              title: boundText(target.title, resolvedLimits.textChars),
            }
          : undefined,
      };
    });
}

function boundElement(
  element: ArchitectureElement,
  limits: Required<QueryLimits>
): ArchitectureElement {
  const compact = withoutMetadata(element);
  return {
    ...compact,
    id: boundText(element.id, limits.textChars),
    parent: boundOptionalText(element.parent, limits.textChars),
    title: boundText(element.title, limits.textChars),
    summary: boundOptionalText(element.summary, limits.textChars),
    description: boundOptionalText(element.description, limits.textChars),
    tags: element.tags?.slice(0, limits.tags).map((tag) => boundText(tag, limits.textChars)),
    sourceRefs: boundSourceRefs(element.sourceRefs, limits),
  };
}

function boundRelationship(
  relationship: ArchitectureRelationship,
  limits: Required<QueryLimits>
): ArchitectureRelationship {
  const compact = withoutMetadata(relationship);
  return {
    ...compact,
    from: boundText(relationship.from, limits.textChars),
    id: boundText(relationship.id, limits.textChars),
    to: boundText(relationship.to, limits.textChars),
    type: boundOptionalText(relationship.type, limits.textChars),
    title: boundOptionalText(relationship.title, limits.textChars),
    description: boundOptionalText(relationship.description, limits.textChars),
    tags: relationship.tags?.slice(0, limits.tags).map((tag) => boundText(tag, limits.textChars)),
    sourceRefs: boundSourceRefs(relationship.sourceRefs, limits),
  };
}

function boundFlow(flow: ArchitectureFlow, limits: Required<QueryLimits>): BoundedFlow {
  const compact = withoutMetadata(flow);
  return {
    ...compact,
    id: boundText(flow.id, limits.textChars),
    title: boundText(flow.title, limits.textChars),
    summary: boundOptionalText(flow.summary, limits.textChars),
    tags: flow.tags?.slice(0, limits.tags).map((tag) => boundText(tag, limits.textChars)),
    sourceRefs: boundSourceRefs(flow.sourceRefs, limits),
    steps: flow.steps.slice(0, limits.flowSteps).map((step) => ({
      ...step,
      element: boundOptionalText(step.element, limits.textChars),
      id: boundText(step.id, limits.textChars),
      relationship: boundOptionalText(step.relationship, limits.textChars),
      title: boundText(step.title, limits.textChars),
      description: boundOptionalText(step.description, limits.textChars),
      sourceRefs: boundSourceRefs(step.sourceRefs, limits),
    })),
    truncated: {
      steps: omittedCount(flow.steps.length, limits.flowSteps),
      sourceRefs: omittedCount(flow.sourceRefs?.length ?? 0, limits.sourceRefs),
    },
  };
}

function boundStateMachine(
  machine: ArchitectureStateMachine,
  limits: Required<QueryLimits>
): BoundedStateMachine {
  const compact = withoutMetadata(machine);
  return {
    ...compact,
    element: boundOptionalText(machine.element, limits.textChars),
    id: boundText(machine.id, limits.textChars),
    title: boundText(machine.title, limits.textChars),
    sourceRefs: boundSourceRefs(machine.sourceRefs, limits),
    states: machine.states.slice(0, limits.states).map((state) => ({
      ...state,
      element: boundOptionalText(state.element, limits.textChars),
      id: boundText(state.id, limits.textChars),
      title: boundText(state.title, limits.textChars),
      description: boundOptionalText(state.description, limits.textChars),
      sourceRefs: boundSourceRefs(state.sourceRefs, limits),
    })),
    transitions: machine.transitions.slice(0, limits.transitions).map((transition) => ({
      ...transition,
      from: boundText(transition.from, limits.textChars),
      relationship: boundOptionalText(transition.relationship, limits.textChars),
      to: boundText(transition.to, limits.textChars),
      event: boundOptionalText(transition.event, limits.textChars),
      description: boundOptionalText(transition.description, limits.textChars),
      sourceRefs: boundSourceRefs(transition.sourceRefs, limits),
    })),
    truncated: {
      states: omittedCount(machine.states.length, limits.states),
      transitions: omittedCount(machine.transitions.length, limits.transitions),
      sourceRefs: omittedCount(machine.sourceRefs?.length ?? 0, limits.sourceRefs),
    },
  };
}

function boundThread(thread: ArchitectureThread, limits: Required<QueryLimits>): BoundedThread {
  return {
    ...thread,
    createdAt: boundText(thread.createdAt, limits.textChars),
    id: boundText(thread.id, limits.textChars),
    target: boundText(thread.target, limits.textChars),
    title: boundText(thread.title, limits.textChars),
    sourceRefs: boundSourceRefs(thread.sourceRefs, limits),
    messages: thread.messages.slice(0, limits.threadMessages).map((message) => ({
      ...message,
      author: boundText(message.author, limits.textChars),
      body: boundText(message.body, limits.textChars),
      createdAt: boundText(message.createdAt, limits.textChars),
      id: boundText(message.id, limits.textChars),
      replyTo: boundOptionalText(message.replyTo, limits.textChars),
    })),
    updatedAt: boundText(thread.updatedAt, limits.textChars),
    truncated: {
      messages: omittedCount(thread.messages.length, limits.threadMessages),
      sourceRefs: omittedCount(thread.sourceRefs?.length ?? 0, limits.sourceRefs),
    },
  };
}

function omittedCount(total: number, limit: number): number {
  return Math.max(0, total - Math.max(0, limit));
}

function boundSourceRefs(
  refs: SourceRef[] | undefined,
  limits: Required<QueryLimits>
): SourceRef[] | undefined {
  return refs?.slice(0, limits.sourceRefs).map((ref) => ({
    ...ref,
    path: boundText(ref.path, limits.textChars),
    label: boundOptionalText(ref.label, limits.textChars),
  }));
}

function boundOptionalText(value: string | undefined, limit: number): string | undefined {
  return value === undefined ? undefined : boundText(value, limit);
}

function boundText(value: string, limit: number): string {
  return value.slice(0, Math.max(0, limit));
}

function resolveQueryLimits(limits: QueryLimits): Required<QueryLimits> {
  const combined = { ...DEFAULT_QUERY_LIMITS, ...limits };
  return Object.fromEntries(
    Object.entries(DEFAULT_QUERY_LIMITS).map(([key, fallback]) => {
      const value = combined[key as keyof typeof combined];
      if (value === undefined) return [key, fallback];
      return [key, Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0];
    })
  ) as unknown as Required<QueryLimits>;
}

function withoutMetadata<T extends { metadata?: unknown }>(record: T): Omit<T, 'metadata'> {
  const compact = { ...record };
  delete compact.metadata;
  return compact;
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
  const visited = new Set([element.id]);
  let current = element.parent;
  while (current) {
    if (visited.has(current)) break;
    visited.add(current);
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
