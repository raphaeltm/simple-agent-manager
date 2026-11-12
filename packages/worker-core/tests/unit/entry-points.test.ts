// Guards the package's public surface: the worker's re-export files and every extracted module
// depend on these names being reachable from the declared entry points.
import { getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import * as core from '../../src/index';
import * as schema from '../../src/schema';

describe('worker-core entry points', () => {
  it('exposes the kernel from the main entry point', () => {
    for (const name of [
      'AppError',
      'errors',
      'log',
      'createModuleLogger',
      'createErrorSinkLogger',
      'serializeError',
      'redactCredentialTokens',
      'startsWithCredentialToken',
      'd1CauseCode',
      'd1ErrorCategory',
      'isFailedQueryError',
      'chunk',
      'D1_MAX_BOUND_PARAMETERS',
      'fetchWithTimeout',
      'withDeadline',
      'getTimeoutMs',
      'IoTimeoutError',
      'deadlineResponse',
      'readBoundedRequestBody',
      'RequestBodyTooLargeError',
      'parseWithSchema',
      'RuntimeValidationError',
      'ulid',
      'parsePositiveInt',
      'requireRouteParam',
      'classifyDurableObjectError',
      'getDurableObjectRetryConfig',
      'resolveSearchQueryLimits',
      'normalizeSearchQuery',
      'buildSafeFtsQuery',
    ]) {
      expect(core, name).toHaveProperty(name);
    }
  });

  it('exposes the D1 schema tables from the schema entry point', () => {
    expect(getTableName(schema.users)).toBe('users');
    expect(getTableName(schema.projects)).toBe('projects');
    expect(getTableName(schema.nodes)).toBe('nodes');
  });

  it('AppError keeps its JSON contract', () => {
    const error = core.errors.badRequest('nope', { field: 'x' });
    expect(error.statusCode).toBe(400);
    expect(error.toJSON()).toEqual({
      error: 'BAD_REQUEST',
      message: 'nope',
      details: { field: 'x' },
    });
  });

  it('ulid returns sortable 26-character ids', () => {
    const a = core.ulid();
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('chunk splits by size with a remainder', () => {
    expect(core.chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
