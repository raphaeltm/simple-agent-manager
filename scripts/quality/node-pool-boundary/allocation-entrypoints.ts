import ts from 'typescript';

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
  'createVM',
  'startComputeTracking',
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
  const aliases = collectEntrypointAliases(sourceFile);
  const moduleDeclarations = collectModuleLevelDeclarations(sourceFile);
  const callsites: AllocationEntrypointCallsite[] = [];
  const seen = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const resolved = resolveEntrypoint(callee, aliases);
      if (resolved) {
        const { entrypoint, viaBareIdentifier } = resolved;
        const { line, column } = positionOf(sourceFile, callee);
        const owner = enclosingFunctionName(node);
        const key = `${line}:${column}:${entrypoint}`;
        // Exempt ONLY genuine recursion: a bare-identifier call to a symbol this
        // module itself declares, from inside that same declaration. Matching on
        // function-name equality alone let `other.provisionNode(...)` inside an
        // unrelated local `provisionNode` suppress itself.
        const isSelfRecursion =
          viaBareIdentifier && owner === entrypoint && moduleDeclarations.has(entrypoint);
        if (!seen.has(key) && !isSelfRecursion) {
          seen.add(key);
          callsites.push({
            filePath: file.filePath,
            line,
            column,
            entrypoint,
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

interface ResolvedEntrypoint {
  entrypoint: AllocationEntrypointCall;
  viaBareIdentifier: boolean;
}

function resolveEntrypoint(
  callee: ts.Expression,
  aliases: Map<string, AllocationEntrypointCall>
): ResolvedEntrypoint | null {
  if (ts.isIdentifier(callee)) {
    if (ENTRYPOINT_SET.has(callee.text)) {
      return { entrypoint: callee.text as AllocationEntrypointCall, viaBareIdentifier: true };
    }
    const aliased = aliases.get(callee.text);
    return aliased ? { entrypoint: aliased, viaBareIdentifier: true } : null;
  }
  if (ts.isPropertyAccessExpression(callee) && ENTRYPOINT_SET.has(callee.name.text)) {
    return { entrypoint: callee.name.text as AllocationEntrypointCall, viaBareIdentifier: false };
  }
  return null;
}

/** `import { createNodeRecord as allocate }` and `const { provisionNode: p } = …`. */
function collectEntrypointAliases(
  sourceFile: ts.SourceFile
): Map<string, AllocationEntrypointCall> {
  const aliases = new Map<string, AllocationEntrypointCall>();

  const bind = (local: string, imported: string): void => {
    if (ENTRYPOINT_SET.has(imported) && local !== imported) {
      aliases.set(local, imported as AllocationEntrypointCall);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node)) {
      bind(node.name.text, node.propertyName?.text ?? node.name.text);
    } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
      for (const element of node.name.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        const property =
          element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.name.text;
        bind(element.name.text, property);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return aliases;
}

/** Module-level function/const declarations, used to identify true recursion. */
function collectModuleLevelDeclarations(sourceFile: ts.SourceFile): Set<string> {
  const declared = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      declared.add(statement.name.text);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declared.add(declaration.name.text);
      }
    }
  }
  return declared;
}
