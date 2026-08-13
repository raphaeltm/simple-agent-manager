import path from 'node:path';

import * as v from 'valibot';

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
import { hasArchitectureTarget } from './targets';
import type { CompiledWorkspace, Located, SourceLocation, WorkspaceIndexes } from './types';

interface DocumentAccumulator {
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
  const accumulator: DocumentAccumulator = {
    elements: [],
    relationships: [],
    flows: [],
    stateMachines: [],
    views: [],
    threads: [...input.threads],
  };

  for (const file of input.files) {
    await mergeDocument(input.workspaceRoot, file, accumulator, diagnostics);
  }

  const manifest = accumulator.manifest ?? {
    version: 1,
    name: path.basename(input.workspaceRoot),
    elements: [],
    relationships: [],
    flows: [],
    stateMachines: [],
    views: [],
  };

  const indexes = buildIndexes(accumulator, diagnostics);
  validateReferences(accumulator, indexes, diagnostics);

  const elements = canonicalValues(accumulator.elements, 'id');
  const relationships = canonicalValues(accumulator.relationships, 'id');
  const flows = canonicalValues(accumulator.flows, 'id');
  const stateMachines = canonicalValues(accumulator.stateMachines, 'id');
  const views = canonicalValues(accumulator.views, 'id');
  const threads = canonicalValues(accumulator.threads, 'id');
  const workspace: CompiledWorkspace = {
    workspaceRoot: input.workspaceRoot,
    repoRoot: input.repoRoot,
    manifest: { ...manifest, elements, relationships, flows, stateMachines, views },
    elements,
    relationships,
    flows,
    stateMachines,
    views,
    threads,
    indexes,
  };

  indexes.childrenByParent = buildChildren(workspace.elements);
  indexes.incomingByElement = groupRelationships(workspace.relationships, 'to');
  indexes.outgoingByElement = groupRelationships(workspace.relationships, 'from');

  return { workspace, diagnostics };
}

async function mergeDocument(
  workspaceRoot: string,
  file: string,
  accumulator: DocumentAccumulator,
  diagnostics: ArchitectureDiagnostic[]
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = (await parseWorkspaceDocument(file)).data;
  } catch (error) {
    diagnostics.push({
      severity: 'error',
      code: 'parse-error',
      file: path.relative(workspaceRoot, file),
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (parsed === undefined || parsed === null) return;

  const result = v.safeParse(workspaceDocumentSchema, parsed);
  const relativeFile = path.relative(workspaceRoot, file);
  if (!result.success) {
    diagnostics.push({
      severity: 'error',
      code: 'schema-invalid',
      file: relativeFile,
      message: summarizeIssues(result.issues),
    });
    return;
  }

  const document = result.output;
  const location = { file: relativeFile, documentPath: '$' };
  if (document.version !== undefined || document.name !== undefined) {
    const manifestResult = v.safeParse(manifestSchema, {
      version: document.version,
      name: document.name,
      description: document.description,
      threadsDir: document.threadsDir,
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
        file: relativeFile,
        message: summarizeIssues(manifestResult.issues),
      });
    } else if (accumulator.manifest !== undefined) {
      diagnostics.push({
        severity: 'error',
        code: 'duplicate-manifest',
        file: relativeFile,
        message: `Manifest already declared in ${accumulator.manifestLocation?.file ?? '(unknown)'}.`,
      });
    } else {
      accumulator.manifest = manifestResult.output;
      accumulator.manifestLocation = location;
    }
  }

  pushLocated(accumulator.elements, document.elements, location, 'elements');
  pushLocated(accumulator.relationships, document.relationships, location, 'relationships');
  pushLocated(accumulator.flows, document.flows, location, 'flows');
  pushLocated(accumulator.stateMachines, document.stateMachines, location, 'stateMachines');
  pushLocated(accumulator.views, document.views, location, 'views');
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

function validateReferences(
  accumulator: DocumentAccumulator,
  indexes: WorkspaceIndexes,
  diagnostics: ArchitectureDiagnostic[]
): void {
  for (const element of accumulator.elements) {
    if (element.value.parent) {
      expectElement(
        element.value.parent,
        element.location,
        `Element "${element.value.id}" parent`,
        indexes,
        diagnostics
      );
    }
  }
  for (const relationship of accumulator.relationships) {
    expectElement(
      relationship.value.from,
      relationship.location,
      `Relationship "${relationship.value.id}" from`,
      indexes,
      diagnostics
    );
    expectElement(
      relationship.value.to,
      relationship.location,
      `Relationship "${relationship.value.id}" to`,
      indexes,
      diagnostics
    );
  }
  for (const flow of accumulator.flows) {
    for (const step of flow.value.steps) {
      if (step.element)
        expectElement(
          step.element,
          flow.location,
          `Flow "${flow.value.id}" step "${step.id}" element`,
          indexes,
          diagnostics
        );
      if (step.relationship)
        expectRelationship(
          step.relationship,
          flow.location,
          `Flow "${flow.value.id}" step "${step.id}" relationship`,
          indexes,
          diagnostics
        );
    }
  }
  for (const machine of accumulator.stateMachines) {
    const stateIds = new Set(machine.value.states.map((state) => state.id));
    if (machine.value.element)
      expectElement(
        machine.value.element,
        machine.location,
        `State machine "${machine.value.id}" element`,
        indexes,
        diagnostics
      );
    for (const state of machine.value.states) {
      if (state.element)
        expectElement(
          state.element,
          machine.location,
          `State machine "${machine.value.id}" state "${state.id}" element`,
          indexes,
          diagnostics
        );
    }
    for (const transition of machine.value.transitions) {
      if (!stateIds.has(transition.from))
        addDangling(
          `State machine "${machine.value.id}" transition from`,
          transition.from,
          machine.location,
          diagnostics
        );
      if (!stateIds.has(transition.to))
        addDangling(
          `State machine "${machine.value.id}" transition to`,
          transition.to,
          machine.location,
          diagnostics
        );
      if (transition.relationship)
        expectRelationship(
          transition.relationship,
          machine.location,
          `State machine "${machine.value.id}" transition relationship`,
          indexes,
          diagnostics
        );
    }
  }
  for (const view of accumulator.views) {
    if (view.value.root)
      expectElement(
        view.value.root,
        view.location,
        `View "${view.value.id}" root`,
        indexes,
        diagnostics
      );
    for (const id of view.value.include ?? [])
      expectElement(id, view.location, `View "${view.value.id}" include`, indexes, diagnostics);
    for (const id of view.value.relationships ?? [])
      expectRelationship(
        id,
        view.location,
        `View "${view.value.id}" relationship`,
        indexes,
        diagnostics
      );
    for (const id of view.value.flows ?? []) {
      if (!indexes.flowsById.has(id))
        addDangling(`View "${view.value.id}" flow`, id, view.location, diagnostics);
    }
    for (const id of view.value.stateMachines ?? []) {
      if (!indexes.stateMachinesById.has(id))
        addDangling(`View "${view.value.id}" state machine`, id, view.location, diagnostics);
    }
  }
  for (const thread of accumulator.threads) {
    if (!hasArchitectureTarget(indexes, thread.value.target)) {
      addDangling(
        `Thread "${thread.value.id}" target`,
        thread.value.target,
        thread.location,
        diagnostics
      );
    }
  }
}

function expectElement(
  id: string,
  location: SourceLocation,
  label: string,
  indexes: WorkspaceIndexes,
  diagnostics: ArchitectureDiagnostic[]
): void {
  if (!indexes.elementsById.has(id)) addDangling(label, id, location, diagnostics);
}

function expectRelationship(
  id: string,
  location: SourceLocation,
  label: string,
  indexes: WorkspaceIndexes,
  diagnostics: ArchitectureDiagnostic[]
): void {
  if (!indexes.relationshipsById.has(id)) addDangling(label, id, location, diagnostics);
}

function addDangling(
  label: string,
  id: string,
  location: SourceLocation,
  diagnostics: ArchitectureDiagnostic[]
): void {
  diagnostics.push({
    severity: 'error',
    code: 'dangling-reference',
    file: location.file,
    path: location.documentPath,
    message: `${label} references missing id "${id}".`,
  });
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
