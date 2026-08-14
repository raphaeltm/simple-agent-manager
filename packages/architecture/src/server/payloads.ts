import {
  DEFAULT_VIEWER_BREADCRUMB_LIMIT,
  DEFAULT_VIEWER_CHILD_LIMIT,
  DEFAULT_VIEWER_FLOW_LIMIT,
  DEFAULT_VIEWER_FLOW_STEP_LIMIT,
  DEFAULT_VIEWER_MAX_ZOOM,
  DEFAULT_VIEWER_MIN_ZOOM,
  DEFAULT_VIEWER_MOBILE_BREAKPOINT_PX,
  DEFAULT_VIEWER_PAN_PIXELS,
  DEFAULT_VIEWER_RELATIONSHIP_LIMIT,
  DEFAULT_VIEWER_STATE_LIMIT,
  DEFAULT_VIEWER_STATE_MACHINE_LIMIT,
  DEFAULT_VIEWER_TRANSITION_LIMIT,
  DEFAULT_VIEWER_ZOOM_STEP,
} from '../constants';
import type { ArchitectureDiagnostic } from '../diagnostics';
import { getWorkspaceSummary, showElement } from '../queries';
import type {
  ArchitectureElement,
  ArchitectureFlow,
  ArchitectureRelationship,
  ArchitectureStateMachine,
  ArchitectureThread,
  SourceRef,
} from '../schemas';
import type { CompiledWorkspace } from '../types';

export type LensName = 'structure' | 'topology' | 'flow' | 'state';

export interface ViewerLimits {
  breadcrumbs: number;
  children: number;
  flowSteps: number;
  flows: number;
  relationships: number;
  stateMachines: number;
  states: number;
  transitions: number;
}

export const DEFAULT_VIEWER_LIMITS: ViewerLimits = {
  breadcrumbs: DEFAULT_VIEWER_BREADCRUMB_LIMIT,
  children: DEFAULT_VIEWER_CHILD_LIMIT,
  flowSteps: DEFAULT_VIEWER_FLOW_STEP_LIMIT,
  flows: DEFAULT_VIEWER_FLOW_LIMIT,
  relationships: DEFAULT_VIEWER_RELATIONSHIP_LIMIT,
  stateMachines: DEFAULT_VIEWER_STATE_MACHINE_LIMIT,
  states: DEFAULT_VIEWER_STATE_LIMIT,
  transitions: DEFAULT_VIEWER_TRANSITION_LIMIT,
};

export interface ViewerInteraction {
  maxZoom: number;
  minZoom: number;
  mobileBreakpointPx: number;
  panPixels: number;
  zoomStep: number;
}

export const DEFAULT_VIEWER_INTERACTION: ViewerInteraction = {
  maxZoom: DEFAULT_VIEWER_MAX_ZOOM,
  minZoom: DEFAULT_VIEWER_MIN_ZOOM,
  mobileBreakpointPx: DEFAULT_VIEWER_MOBILE_BREAKPOINT_PX,
  panPixels: DEFAULT_VIEWER_PAN_PIXELS,
  zoomStep: DEFAULT_VIEWER_ZOOM_STEP,
};

export interface ViewerModel {
  summary: ReturnType<typeof getWorkspaceSummary>;
  diagnostics: ArchitectureDiagnostic[];
  interaction: ViewerInteraction;
  limits: ViewerLimits;
  workspace: {
    name: string;
    description?: string;
    elements: ArchitectureElement[];
    relationships: ArchitectureRelationship[];
    flows: ArchitectureFlow[];
    stateMachines: ArchitectureStateMachine[];
    threads: ArchitectureThread[];
  };
}

export function makeViewerModel(
  workspace: CompiledWorkspace,
  diagnostics: ArchitectureDiagnostic[],
  limits: ViewerLimits = DEFAULT_VIEWER_LIMITS,
  interaction: ViewerInteraction = DEFAULT_VIEWER_INTERACTION
): ViewerModel {
  return {
    summary: getWorkspaceSummary(workspace),
    diagnostics,
    interaction,
    limits,
    workspace: {
      name: workspace.manifest.name,
      description: workspace.manifest.description,
      elements: workspace.elements,
      relationships: workspace.relationships,
      flows: workspace.flows,
      stateMachines: workspace.stateMachines,
      threads: workspace.threads,
    },
  };
}

export function makeElementDetails(
  workspace: CompiledWorkspace,
  elementId: string,
  limits = DEFAULT_VIEWER_LIMITS
) {
  return showElement(workspace, elementId, {
    children: limits.children,
    incoming: limits.relationships,
    outgoing: limits.relationships,
  });
}

export function sourceRefsForTarget(
  workspace: CompiledWorkspace,
  target: string
): SourceRef[] | undefined {
  const element = workspace.indexes.elementsById.get(target)?.value;
  if (element) return element.sourceRefs ?? [];
  const relationship = workspace.indexes.relationshipsById.get(target)?.value;
  if (relationship) return relationship.sourceRefs ?? [];
  const flow = workspace.indexes.flowsById.get(target)?.value;
  if (flow) return flow.sourceRefs ?? [];
  const machine = workspace.indexes.stateMachinesById.get(target)?.value;
  if (machine) return machine.sourceRefs ?? [];
  const thread = workspace.indexes.threadsById.get(target)?.value;
  return thread?.sourceRefs ?? undefined;
}
