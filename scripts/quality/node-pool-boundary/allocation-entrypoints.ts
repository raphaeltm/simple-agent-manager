import ts from 'typescript';

import { createBindings } from './bindings';
import {
  enclosingFunctionName,
  parseSourceFile,
  pathStartsWithAny,
  positionOf,
  type SourceFileInput,
  sourceLine,
} from './source-files';

/**
 * Allocation and provisioning does not only happen through an `INSERT`. These
 * shared services allocate or pay for capacity on behalf of a caller, so the
 * CALLER is the allocation entrypoint that must carry a scope/role/admission
 * contract. Inventorying only the shared service would let any new caller
 * conceal a bypass behind `createNodeRecord`.
 */
export const ALLOCATION_ENTRYPOINT_CALLS = [
  'createNodeRecord',
  'provisionNode',
  'reserveWorkspacePlacement',
  'createWorkspaceOnNode',
  'startComputeTracking',
  'createVM',
] as const;

export type AllocationEntrypointCall = (typeof ALLOCATION_ENTRYPOINT_CALLS)[number];

const ENTRYPOINT_SET = new Set<string>(ALLOCATION_ENTRYPOINT_CALLS);

export interface AllocationEntrypointCallsite {
  filePath: string;
  line: number;
  column: number;
  entrypoint: AllocationEntrypointCall;
  owner: string;
  snippet: string;
}

export const ALLOCATION_ENTRYPOINT_ROOTS = ['apps/api/src'] as const;

export function scanAllocationEntrypoints(
  files: readonly SourceFileInput[]
): AllocationEntrypointCallsite[] {
  return files
    .filter((file) => pathStartsWithAny(file.filePath, ALLOCATION_ENTRYPOINT_ROOTS))
    .flatMap((file) => scanAllocationEntrypointFile(file));
}

function scanAllocationEntrypointFile(file: SourceFileInput): AllocationEntrypointCallsite[] {
  const sourceFile = parseSourceFile(file);
  const bindings = createBindings(sourceFile);
  const callsites: AllocationEntrypointCallsite[] = [];
  const seen = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = bindings.symbolName(callee, ENTRYPOINT_SET);
      if (name && ENTRYPOINT_SET.has(name)) {
        const { line, column } = positionOf(sourceFile, callee);
        const owner = enclosingFunctionName(node);
        const key = `${line}:${column}:${name}`;
        if (!seen.has(key)) {
          seen.add(key);
          callsites.push({
            filePath: file.filePath,
            line,
            column,
            entrypoint: name as AllocationEntrypointCall,
            owner,
            snippet: sourceLine(file.source, line - 1),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return callsites;
}
