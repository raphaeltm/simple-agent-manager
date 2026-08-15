import type { CompiledWorkspace, WorkspaceIndexes } from './types';

export type ArchitectureTargetKind = 'element' | 'relationship' | 'flow' | 'stateMachine';

export interface ArchitectureTarget {
  id: string;
  kind: ArchitectureTargetKind;
  title: string;
}

export function hasArchitectureTarget(indexes: WorkspaceIndexes, id: string): boolean {
  return Boolean(
    indexes.elementsById.has(id) ||
    indexes.relationshipsById.has(id) ||
    indexes.flowsById.has(id) ||
    indexes.stateMachinesById.has(id)
  );
}

export function resolveArchitectureTarget(
  workspace: CompiledWorkspace,
  id: string
): ArchitectureTarget | undefined {
  const element = workspace.indexes.elementsById.get(id)?.value;
  if (element) return { id, kind: 'element', title: element.title };
  const relationship = workspace.indexes.relationshipsById.get(id)?.value;
  if (relationship) return { id, kind: 'relationship', title: relationship.title ?? id };
  const flow = workspace.indexes.flowsById.get(id)?.value;
  if (flow) return { id, kind: 'flow', title: flow.title };
  const machine = workspace.indexes.stateMachinesById.get(id)?.value;
  if (machine) return { id, kind: 'stateMachine', title: machine.title };
  return undefined;
}
