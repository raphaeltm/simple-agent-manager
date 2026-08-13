import type { DocumentAccumulator } from './compiler';
import type { ArchitectureDiagnostic } from './diagnostics';
import type { ArchitectureElement, ArchitectureStateMachine, SourceRef } from './schemas';
import { hasArchitectureTarget } from './targets';
import type { Located, SourceLocation, WorkspaceIndexes } from './types';

export function validateWorkspace(
  accumulator: DocumentAccumulator,
  indexes: WorkspaceIndexes,
  diagnostics: ArchitectureDiagnostic[]
): void {
  validateNestedIdentity(accumulator, diagnostics);
  validateParentCycles(accumulator.elements, diagnostics);
  validateSourceRanges(accumulator, diagnostics);
  validateReferences(accumulator, indexes, diagnostics);
}

function validateNestedIdentity(
  accumulator: DocumentAccumulator,
  diagnostics: ArchitectureDiagnostic[]
): void {
  for (const flow of accumulator.flows) {
    validateIds(flow.value.steps, `Flow "${flow.value.id}" step`, flow.location, diagnostics);
  }
  for (const machine of accumulator.stateMachines) {
    validateIds(
      machine.value.states,
      `State machine "${machine.value.id}" state`,
      machine.location,
      diagnostics
    );
  }
  for (const thread of accumulator.threads) {
    validateIds(
      thread.value.messages,
      `Thread "${thread.value.id}" message`,
      thread.location,
      diagnostics
    );
  }
}

function validateIds(
  records: readonly { id: string }[],
  label: string,
  location: SourceLocation,
  diagnostics: ArchitectureDiagnostic[]
): void {
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) {
      diagnostics.push({
        severity: 'error',
        code: 'duplicate-id',
        file: location.file,
        path: location.documentPath,
        message: `Duplicate ${label} id "${record.id}".`,
      });
    }
    ids.add(record.id);
  }
}

function validateParentCycles(
  elements: readonly Located<ArchitectureElement>[],
  diagnostics: ArchitectureDiagnostic[]
): void {
  const byId = new Map(elements.map((entry) => [entry.value.id, entry]));
  for (const entry of elements) {
    const visited = new Set([entry.value.id]);
    let parentId = entry.value.parent;
    while (parentId) {
      if (visited.has(parentId)) {
        diagnostics.push({
          severity: 'error',
          code: 'parent-cycle',
          file: entry.location.file,
          path: entry.location.documentPath,
          message: `Element "${entry.value.id}" participates in a parent cycle at "${parentId}".`,
        });
        break;
      }
      visited.add(parentId);
      parentId = byId.get(parentId)?.value.parent;
    }
  }
}

function validateSourceRanges(
  accumulator: DocumentAccumulator,
  diagnostics: ArchitectureDiagnostic[]
): void {
  for (const [label, refs, location] of sourceBackedRecords(accumulator)) {
    for (const ref of refs) {
      if (ref.startLine && ref.endLine && ref.endLine < ref.startLine) {
        diagnostics.push({
          severity: 'error',
          code: 'source-range-invalid',
          file: location.file,
          path: location.documentPath,
          message: `${label} source range ends before it starts: ${ref.path}.`,
        });
      }
    }
  }
}

function sourceBackedRecords(
  accumulator: DocumentAccumulator
): Array<[string, SourceRef[], SourceLocation]> {
  const records: Array<[string, SourceRef[], SourceLocation]> = [];
  const add = (label: string, refs: SourceRef[] | undefined, location: SourceLocation) => {
    if (refs) records.push([label, refs, location]);
  };
  for (const entry of accumulator.elements)
    add(`Element "${entry.value.id}"`, entry.value.sourceRefs, entry.location);
  for (const entry of accumulator.relationships)
    add(`Relationship "${entry.value.id}"`, entry.value.sourceRefs, entry.location);
  for (const entry of accumulator.flows) {
    add(`Flow "${entry.value.id}"`, entry.value.sourceRefs, entry.location);
    for (const step of entry.value.steps)
      add(`Flow step "${step.id}"`, step.sourceRefs, entry.location);
  }
  addStateMachineSourceRecords(accumulator.stateMachines, records);
  for (const entry of accumulator.threads)
    add(`Thread "${entry.value.id}"`, entry.value.sourceRefs, entry.location);
  return records;
}

function addStateMachineSourceRecords(
  machines: DocumentAccumulator['stateMachines'],
  records: Array<[string, SourceRef[], SourceLocation]>
): void {
  const add = (label: string, refs: SourceRef[] | undefined, location: SourceLocation) => {
    if (refs) records.push([label, refs, location]);
  };
  for (const entry of machines) {
    add(`State machine "${entry.value.id}"`, entry.value.sourceRefs, entry.location);
    for (const state of entry.value.states)
      add(`State "${state.id}"`, state.sourceRefs, entry.location);
    for (const transition of entry.value.transitions)
      add('State transition', transition.sourceRefs, entry.location);
  }
}

function validateReferences(
  accumulator: DocumentAccumulator,
  indexes: WorkspaceIndexes,
  diagnostics: ArchitectureDiagnostic[]
): void {
  validateElementReferences(accumulator, indexes, diagnostics);
  validateRelationshipReferences(accumulator, indexes, diagnostics);
  validateFlowReferences(accumulator, indexes, diagnostics);
  validateStateMachineReferences(accumulator, indexes, diagnostics);
  validateViewReferences(accumulator, indexes, diagnostics);
  validateThreadReferences(accumulator, indexes, diagnostics);
}

function validateElementReferences(
  accumulator: DocumentAccumulator,
  indexes: WorkspaceIndexes,
  diagnostics: ArchitectureDiagnostic[]
): void {
  for (const element of accumulator.elements) {
    if (element.value.parent)
      expectElement(
        element.value.parent,
        element.location,
        `Element "${element.value.id}" parent`,
        indexes,
        diagnostics
      );
  }
}

function validateRelationshipReferences(
  accumulator: DocumentAccumulator,
  indexes: WorkspaceIndexes,
  diagnostics: ArchitectureDiagnostic[]
): void {
  for (const relationship of accumulator.relationships) {
    const label = `Relationship "${relationship.value.id}"`;
    expectElement(
      relationship.value.from,
      relationship.location,
      `${label} from`,
      indexes,
      diagnostics
    );
    expectElement(
      relationship.value.to,
      relationship.location,
      `${label} to`,
      indexes,
      diagnostics
    );
  }
}

function validateFlowReferences(
  accumulator: DocumentAccumulator,
  indexes: WorkspaceIndexes,
  diagnostics: ArchitectureDiagnostic[]
): void {
  for (const flow of accumulator.flows) {
    for (const step of flow.value.steps) {
      const label = `Flow "${flow.value.id}" step "${step.id}"`;
      if (step.element)
        expectElement(step.element, flow.location, `${label} element`, indexes, diagnostics);
      if (step.relationship)
        expectRelationship(
          step.relationship,
          flow.location,
          `${label} relationship`,
          indexes,
          diagnostics
        );
    }
  }
}

function validateStateMachineReferences(
  accumulator: DocumentAccumulator,
  indexes: WorkspaceIndexes,
  diagnostics: ArchitectureDiagnostic[]
): void {
  for (const machine of accumulator.stateMachines) {
    const label = `State machine "${machine.value.id}"`;
    if (machine.value.element)
      expectElement(
        machine.value.element,
        machine.location,
        `${label} element`,
        indexes,
        diagnostics
      );
    for (const state of machine.value.states) {
      if (state.element)
        expectElement(
          state.element,
          machine.location,
          `${label} state "${state.id}" element`,
          indexes,
          diagnostics
        );
    }
    validateTransitions(machine.value, machine.location, indexes, diagnostics);
  }
}

function validateTransitions(
  machine: ArchitectureStateMachine,
  location: SourceLocation,
  indexes: WorkspaceIndexes,
  diagnostics: ArchitectureDiagnostic[]
): void {
  const stateIds = new Set(machine.states.map((state) => state.id));
  for (const transition of machine.transitions) {
    const label = `State machine "${machine.id}" transition`;
    if (!stateIds.has(transition.from))
      addDangling(`${label} from`, transition.from, location, diagnostics);
    if (!stateIds.has(transition.to))
      addDangling(`${label} to`, transition.to, location, diagnostics);
    if (transition.relationship)
      expectRelationship(
        transition.relationship,
        location,
        `${label} relationship`,
        indexes,
        diagnostics
      );
  }
}

function validateViewReferences(
  accumulator: DocumentAccumulator,
  indexes: WorkspaceIndexes,
  diagnostics: ArchitectureDiagnostic[]
): void {
  for (const view of accumulator.views) {
    const label = `View "${view.value.id}"`;
    if (view.value.root)
      expectElement(view.value.root, view.location, `${label} root`, indexes, diagnostics);
    for (const id of view.value.include ?? [])
      expectElement(id, view.location, `${label} include`, indexes, diagnostics);
    for (const id of view.value.relationships ?? [])
      expectRelationship(id, view.location, `${label} relationship`, indexes, diagnostics);
    for (const id of view.value.flows ?? []) {
      if (!indexes.flowsById.has(id)) addDangling(`${label} flow`, id, view.location, diagnostics);
    }
    for (const id of view.value.stateMachines ?? []) {
      if (!indexes.stateMachinesById.has(id))
        addDangling(`${label} state machine`, id, view.location, diagnostics);
    }
  }
}

function validateThreadReferences(
  accumulator: DocumentAccumulator,
  indexes: WorkspaceIndexes,
  diagnostics: ArchitectureDiagnostic[]
): void {
  for (const thread of accumulator.threads) {
    if (!hasArchitectureTarget(indexes, thread.value.target))
      addDangling(
        `Thread "${thread.value.id}" target`,
        thread.value.target,
        thread.location,
        diagnostics
      );
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
