import { DEFAULT_VIEWER_CHILD_LIMIT, DEFAULT_VIEWER_RELATIONSHIP_LIMIT } from '../constants';
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

export type LensName = 'structure' | 'flow' | 'state';

export interface ViewerModel {
  summary: ReturnType<typeof getWorkspaceSummary>;
  diagnostics: ArchitectureDiagnostic[];
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
  diagnostics: ArchitectureDiagnostic[]
): ViewerModel {
  return {
    summary: getWorkspaceSummary(workspace),
    diagnostics,
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

export function makeElementDetails(workspace: CompiledWorkspace, elementId: string) {
  return showElement(workspace, elementId, {
    children: DEFAULT_VIEWER_CHILD_LIMIT,
    incoming: DEFAULT_VIEWER_RELATIONSHIP_LIMIT,
    outgoing: DEFAULT_VIEWER_RELATIONSHIP_LIMIT,
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
