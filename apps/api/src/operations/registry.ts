import { toJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

import { platformOperations } from './platform-operations';
import type { Operation } from './types';

/** One catalog shared by adapters. Names remain stable across surfaces. */
export const operations = platformOperations;

export function operationInputJsonSchema(
  operation: Pick<Operation<unknown, unknown>, 'input'>
): unknown {
  return toJsonSchema(operation.input);
}

export function operationOutputJsonSchema(
  operation: Pick<Operation<unknown, unknown>, 'output'>
): unknown {
  return operation.output ? toJsonSchema(operation.output) : undefined;
}

export const ProjectInputSchema = v.object({ projectId: v.string() });
