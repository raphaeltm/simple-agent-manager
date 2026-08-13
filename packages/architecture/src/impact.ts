import { access } from 'node:fs/promises';

import { normalizeRepoRelativePath, resolveContainedPath } from './path-safety';
import type { SourceRef } from './schemas';
import type { CompiledWorkspace, SourceBackedRecord } from './types';

export interface ImpactedRecord {
  kind: 'element' | 'relationship' | 'flow' | 'stateMachine';
  id: string;
  title?: string;
  sourceRefs: SourceRef[];
}

export interface BrokenSourceReference {
  ownerKind: ImpactedRecord['kind'];
  ownerId: string;
  path: string;
  reason: string;
}

export interface ImpactReport {
  changedPaths: string[];
  impacted: ImpactedRecord[];
  brokenSourceRefs: BrokenSourceReference[];
}

export async function mapChangedPathsToArchitecture(
  workspace: CompiledWorkspace,
  changedPaths: readonly string[]
): Promise<ImpactReport> {
  const normalizedChangedPaths = changedPaths.map(normalizeRepoRelativePath).sort();
  const changedSet = new Set(normalizedChangedPaths);
  const records = collectSourceBackedRecords(workspace);
  const impacted = records
    .filter(({ record }) =>
      (record.sourceRefs ?? []).some((sourceRef) => pathMatches(sourceRef.path, changedSet))
    )
    .map(({ kind, record }) => ({
      kind,
      id: record.id,
      title: 'title' in record && typeof record.title === 'string' ? record.title : undefined,
      sourceRefs: record.sourceRefs ?? [],
    }));
  return {
    changedPaths: normalizedChangedPaths,
    impacted: impacted.sort((left, right) =>
      `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`)
    ),
    brokenSourceRefs: await findBrokenSourceRefs(workspace, records),
  };
}

function collectSourceBackedRecords(workspace: CompiledWorkspace): {
  kind: ImpactedRecord['kind'];
  record: SourceBackedRecord & { title?: string };
}[] {
  return [
    ...workspace.elements.map((record) => ({ kind: 'element' as const, record })),
    ...workspace.relationships.map((record) => ({ kind: 'relationship' as const, record })),
    ...workspace.flows.map((record) => ({
      kind: 'flow' as const,
      record: {
        ...record,
        sourceRefs: uniqueSourceRefs([
          ...(record.sourceRefs ?? []),
          ...record.steps.flatMap((step) => step.sourceRefs ?? []),
        ]),
      },
    })),
    ...workspace.stateMachines.map((record) => ({
      kind: 'stateMachine' as const,
      record: {
        ...record,
        sourceRefs: uniqueSourceRefs([
          ...(record.sourceRefs ?? []),
          ...record.states.flatMap((state) => state.sourceRefs ?? []),
          ...record.transitions.flatMap((transition) => transition.sourceRefs ?? []),
        ]),
      },
    })),
  ];
}

function uniqueSourceRefs(sourceRefs: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  return sourceRefs.filter((sourceRef) => {
    const key = `${sourceRef.path}:${sourceRef.startLine ?? ''}:${sourceRef.endLine ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function findBrokenSourceRefs(
  workspace: CompiledWorkspace,
  records: ReturnType<typeof collectSourceBackedRecords>
): Promise<BrokenSourceReference[]> {
  const broken: BrokenSourceReference[] = [];
  for (const { kind, record } of records) {
    for (const sourceRef of record.sourceRefs ?? []) {
      try {
        const absolutePath = await resolveContainedPath({
          root: workspace.repoRoot,
          relativePath: sourceRef.path,
          mustExist: false,
        });
        await access(absolutePath);
      } catch (error) {
        broken.push({
          ownerKind: kind,
          ownerId: record.id,
          path: sourceRef.path,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return broken.sort((left, right) =>
    `${left.ownerKind}:${left.ownerId}:${left.path}`.localeCompare(
      `${right.ownerKind}:${right.ownerId}:${right.path}`
    )
  );
}

function pathMatches(sourcePath: string, changedSet: Set<string>): boolean {
  const normalizedSourcePath = normalizeRepoRelativePath(sourcePath);
  for (const changedPath of changedSet) {
    if (changedPath === normalizedSourcePath) return true;
    if (changedPath.startsWith(`${normalizedSourcePath}/`)) return true;
    if (normalizedSourcePath.startsWith(`${changedPath}/`)) return true;
  }
  return false;
}
