import { readFileSync } from 'node:fs';
import path from 'node:path';

import { TASK_EXECUTION_STEPS } from '@simple-agent-manager/shared';
import { type Expression, Node, type ObjectLiteralExpression, Project, SyntaxKind } from 'ts-morph';
import { describe, expect, it } from 'vitest';

import { SRC_ROOT } from '../../helpers/source-tree';

function propertyInitializer(
  objectLiteral: ObjectLiteralExpression,
  propertyName: string
): Expression | undefined {
  const property = objectLiteral.getProperty(propertyName);
  if (!Node.isPropertyAssignment(property)) return undefined;
  return property.getInitializer();
}

function literalPropertyValue(
  objectLiteral: ObjectLiteralExpression,
  propertyName: string
): string | null {
  const initializer = propertyInitializer(objectLiteral, propertyName);
  if (!initializer || !Node.isStringLiteral(initializer)) return null;
  return initializer.getLiteralValue();
}

function findInstantRunningTaskUpdate(): ObjectLiteralExpression {
  const sourcePath = path.join(SRC_ROOT, 'services/instant-session.ts');
  const project = new Project({ useInMemoryFileSystem: true });
  const source = project.createSourceFile('instant-session.ts', readFileSync(sourcePath, 'utf8'), {
    overwrite: true,
  });

  const candidates = source
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => call.getExpression().getText().endsWith('.set'))
    .map((call) => call.getArguments()[0])
    .filter(Node.isObjectLiteralExpression)
    .filter((objectLiteral) => literalPropertyValue(objectLiteral, 'status') === 'in_progress')
    .filter((objectLiteral) => propertyInitializer(objectLiteral, 'executionStep'));

  expect(
    candidates,
    'Expected to find the Instant runtime task update that marks a session in_progress.'
  ).toHaveLength(1);

  return candidates[0];
}

function taskExecutionStepHelperLiteral(initializer: Expression): string | null {
  if (!Node.isCallExpression(initializer)) return null;
  if (initializer.getExpression().getText() !== 'taskExecutionStep') return null;
  const [arg] = initializer.getArguments();
  if (!Node.isStringLiteral(arg)) return null;
  return arg.getLiteralValue();
}

describe('Instant execution-step writer contract', () => {
  it('writes the shared running step through the typed helper once the ACP agent is running', () => {
    const taskUpdate = findInstantRunningTaskUpdate();
    const initializer = propertyInitializer(taskUpdate, 'executionStep');

    expect(initializer, 'The in_progress task update must write executionStep.').toBeDefined();

    const helperLiteral = taskExecutionStepHelperLiteral(initializer!);

    expect(
      helperLiteral,
      'Use taskExecutionStep(...) so TypeScript rejects out-of-contract literals at the write site.'
    ).toBe('running');
    expect(TASK_EXECUTION_STEPS).toContain(helperLiteral);
  });
});
