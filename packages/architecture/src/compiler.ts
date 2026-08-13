import path from 'node:path';

import * as v from 'valibot';

import { validateWorkspace } from './compiler-validation';
import type { ArchitectureDiagnostic } from './diagnostics';
import { parseWorkspaceDocument } from './document';
import {
  type ArchitectureElement,
  type ArchitectureFlow,
  type ArchitectureManifest,
  type ArchitectureRelationship,
  type ArchitectureStateMachine,
  type ArchitectureThread,
  type ArchitectureView,
  manifestSchema,
  workspaceDocumentSchema,
} from './schemas';
import type { CompiledWorkspace, Located, SourceLocation, WorkspaceIndexes } from './types';

export interface DocumentAccumulator {
  manifest?: ArchitectureManifest;
  manifestLocation?: SourceLocation;
  elements: Located<ArchitectureElement>[];
  relationships: Located<ArchitectureRelationship>[];
  flows: Located<ArchitectureFlow>[];
  stateMachines: Located<ArchitectureStateMachine>[];
  views: Located<ArchitectureView>[];
  threads: Located<ArchitectureThread>[];
}

interface CompileInput {
  workspaceRoot: string;
  repoRoot: string;
  files: string[];
  threads: Located<ArchitectureThread>[];
}

export async function compileWorkspace(input: CompileInput): Promise<{
  workspace: CompiledWorkspace;
  diagnostics: ArchitectureDiagnostic[];
}> {
  const diagnostics: ArchitectureDiagnostic[] = [];
  const accumulator = createAccumulator(input.threads);

  for (const file of input.files) {
    await mergeDocument(input.workspaceRoot, file, accumulator, diagnostics);
  }

  const indexes = buildIndexes(accumulator, diagnostics);
  validateWorkspace(accumulator, indexes, diagnostics);
  const workspace = buildCompiledWorkspace(input, accumulator, indexes, diagnostics);
  return { workspace, diagnostics };
}

function createAccumulator(threads: Located<ArchitectureThread>[]): DocumentAccumulator {
  return {
    elements: [],
    relationships: [],
    flows: [],
    stateMachines: [],
    views: [],
    threads: [...threads],
  };
}

function buildCompiledWorkspace(
  input: CompileInput,
  accumulator: DocumentAccumulator,
  indexes: WorkspaceIndexes,
  diagnostics: ArchitectureDiagnostic[]
): CompiledWorkspace {
  const manifest = resolveManifest(input.workspaceRoot, accumulator, diagnostics);
  const elements = canonicalValues(accumulator.elements, 'id');
  const relationships = canonicalValues(accumulator.relationships, 'id');
  const flows = canonicalValues(accumulator.flows, 'id');
  const stateMachines = canonicalValues(accumulator.stateMachines, 'id');
  const views = canonicalValues(accumulator.views, 'id');
  const workspace: CompiledWorkspace = {
    workspaceRoot: input.workspaceRoot,
    repoRoot: input.repoRoot,
    manifest: { ...manifest, elements, relationships, flows, stateMachines, views },
    elements,
    relationships,
    flows,
    stateMachines,
    views,
    threads: canonicalValues(accumulator.threads, 'id'),
    indexes,
  };
  indexes.childrenByParent = buildChildren(workspace.elements);
  indexes.incomingByElement = groupRelationships(workspace.relationships, 'to');
  indexes.outgoingByElement = groupRelationships(workspace.relationships, 'from');
  return workspace;
}

function resolveManifest(
  workspaceRoot: string,
  accumulator: DocumentAccumulator,
  diagnostics: ArchitectureDiagnostic[]
): ArchitectureManifest {
  if (accumulator.manifest) return accumulator.manifest;
  diagnostics.push({
    severity: 'error',
    code: 'manifest-missing',
    message: 'Architecture workspace must declare exactly one versioned manifest.',
  });
  return {
    version: 1,
    name: path.basename(workspaceRoot),
    elements: [],
    relationships: [],
    flows: [],
    stateMachines: [],
    views: [],
  };
}

async function mergeDocument(
  workspaceRoot: string,
  file: string,
  accumulator: DocumentAccumulator,
  diagnostics: ArchitectureDiagnostic[]
): Promise<void> {
  const relativeFile = path.relative(workspaceRoot, file);
  const document = await parseAndValidateDocument(file, relativeFile, diagnostics);
  if (!document) return;
  const location = { file: relativeFile, documentPath: '$' };
  mergeManifest(document, location, accumulator, diagnostics);
  pushLocated(accumulator.elements, document.elements, location, 'elements');
  pushLocated(accumulator.relationships, document.relationships, location, 'relationships');
  pushLocated(accumulator.flows, document.flows, location, 'flows');
  pushLocated(accumulator.stateMachines, document.stateMachines, location, 'stateMachines');
  pushLocated(accumulator.views, document.views, location, 'views');
}

async function parseAndValidateDocument(
  file: string,
  relativeFile: string,
  diagnostics: ArchitectureDiagnostic[]
) {
  let parsed: unknown;
  try {
    parsed = (await parseWorkspaceDocument(file)).data;
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      code: 'parse-error',
      file: relativeFile,
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  if (parsed === undefined || parsed === null) return undefined;

  const result = v.safeParse(workspaceDocumentSchema, parsed);
  if (!result.success) {
    diagnostics.push({
      severity: 'error',
      code: 'schema-invalid',
      file: relativeFile,
      message: summarizeIssues(result.issues),
    });
    return undefined;
  }
  return result.output;
}

function mergeManifest(
  document: v.InferOutput<typeof workspaceDocumentSchema>,
  location: SourceLocation,
  accumulator: DocumentAccumulator,
  diagnostics: ArchitectureDiagnostic[]
): void {
  if (document.version === undefined && document.name === undefined) return;
  const manifestResult = v.safeParse(manifestSchema, {
    ...document,
    elements: [],
    relationships: [],
    flows: [],
    stateMachines: [],
    views: [],
  });
  if (!manifestResult.success) {
    diagnostics.push({
      severity: 'error',
      code: 'manifest-invalid',
      file: location.file,
      message: summarizeIssues(manifestResult.issues),
    });
  } else if (accumulator.manifest !== undefined) {
    diagnostics.push({
      severity: 'error',
      code: 'duplicate-manifest',
      file: location.file,
      message: `Manifest already declared in ${accumulator.manifestLocation?.file ?? '(unknown)'}.`,
    });
  } else {
    accumulator.manifest = manifestResult.output;
    accumulator.manifestLocation = location;
  }
}

function pushLocated<T>(
  target: Located<T>[],
  values: T[] | undefined,
  location: SourceLocation,
  documentPath: string
): void {
  for (const value of values ?? []) target.push({ value, location: { ...location, documentPath } });
}

function buildIndexes(
  accumulator: DocumentAccumulator,
  diagnostics: ArchitectureDiagnostic[]
): WorkspaceIndexes {
  return {
    elementsById: uniqueIndex(accumulator.elements, 'elements', diagnostics),
    relationshipsById: uniqueIndex(accumulator.relationships, 'relationships', diagnostics),
    flowsById: uniqueIndex(accumulator.flows, 'flows', diagnostics),
    stateMachinesById: uniqueIndex(accumulator.stateMachines, 'stateMachines', diagnostics),
    viewsById: uniqueIndex(accumulator.views, 'views', diagnostics),
    threadsById: uniqueIndex(accumulator.threads, 'threads', diagnostics),
    childrenByParent: new Map(),
    incomingByElement: new Map(),
    outgoingByElement: new Map(),
  };
}

function uniqueIndex<T extends { id: string }>(
  records: Located<T>[],
  recordKind: string,
  diagnostics: ArchitectureDiagnostic[]
): Map<string, Located<T>> {
  const index = new Map<string, Located<T>>();
  for (const located of records) {
    const existing = index.get(located.value.id);
    if (existing) {
      diagnostics.push({
        severity: 'error',
        code: 'duplicate-id',
        file: located.location.file,
        path: located.location.documentPath,
        message: `Duplicate ${recordKind} id "${located.value.id}" also declared in ${existing.location.file}.`,
      });
      continue;
    }
    index.set(located.value.id, located);
  }
  return index;
}

function buildChildren(
  elements: readonly ArchitectureElement[]
): Map<string, ArchitectureElement[]> {
  const childrenByParent = new Map<string, ArchitectureElement[]>();
  for (const element of elements) {
    if (!element.parent) continue;
    const children = childrenByParent.get(element.parent) ?? [];
    children.push(element);
    childrenByParent.set(element.parent, children);
  }
  for (const children of childrenByParent.values()) children.sort(compareById);
  return childrenByParent;
}

function groupRelationships(
  relationships: readonly ArchitectureRelationship[],
  key: 'from' | 'to'
): Map<string, ArchitectureRelationship[]> {
  const grouped = new Map<string, ArchitectureRelationship[]>();
  for (const relationship of relationships) {
    const values = grouped.get(relationship[key]) ?? [];
    values.push(relationship);
    grouped.set(relationship[key], values);
  }
  for (const values of grouped.values()) values.sort(compareById);
  return grouped;
}

function canonicalValues<T extends { id: string }>(values: Located<T>[], key: keyof T): T[] {
  return values
    .map((entry) => entry.value)
    .sort((left, right) => String(left[key]).localeCompare(String(right[key])));
}

function compareById(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}

function summarizeIssues(issues: readonly v.BaseIssue<unknown>[]): string {
  return issues.map((issue) => issue.message).join('; ');
}
