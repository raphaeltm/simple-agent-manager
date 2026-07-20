import { describe, expect, it } from 'vitest';

import {
  buildWebhookContext,
  canonicalJson,
  evaluateWebhookFilters,
  normalizeIncludedHeaders,
  parseWebhookJsonObject,
  resolveWebhookPath,
  selectWebhookHeaders,
} from '../../../src/services/webhook-trigger-payload';

describe('webhook trigger payload handling', () => {
  const body = { event: { action: 'created', labels: ['urgent', 'ops'] }, count: 3 };

  it('accepts JSON objects only and canonicalizes keys recursively', () => {
    expect(parseWebhookJsonObject('{"b":1,"a":{"d":2,"c":3}}')).toEqual({
      b: 1,
      a: { d: 2, c: 3 },
    });
    expect(parseWebhookJsonObject('[]')).toBeNull();
    expect(parseWebhookJsonObject('null')).toBeNull();
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('resolves owned safe dot paths and blocks prototype/deep traversal', () => {
    expect(resolveWebhookPath(body, 'event.action', 4)).toBe('created');
    expect(resolveWebhookPath(body, '__proto__.polluted', 4)).toBeUndefined();
    expect(resolveWebhookPath(body, 'event.constructor.name', 4)).toBeUndefined();
    expect(resolveWebhookPath(body, 'event.action.too.deep', 2)).toBeUndefined();
  });

  it('evaluates all and any filter modes deterministically', () => {
    const filters = [
      { path: 'event.action', operator: 'equals' as const, value: 'created' },
      { path: 'event.labels', operator: 'contains' as const, value: 'urgent' },
      { path: 'missing', operator: 'exists' as const },
    ];
    expect(evaluateWebhookFilters(body, filters, 'all', 4)).toMatchObject({
      matched: false,
      matchedFilters: 2,
    });
    expect(evaluateWebhookFilters(body, filters, 'any', 4)).toMatchObject({ matched: true });
  });

  it('permanently excludes credential-bearing headers', () => {
    expect(
      normalizeIncludedHeaders(['X-Request-ID', 'authorization', 'x-api-token', 'x-request-id'])
    ).toEqual(['x-request-id']);
    expect(
      selectWebhookHeaders({ 'x-request-id': 'request-1', authorization: 'Bearer secret' }, [
        'x-request-id',
        'authorization',
      ])
    ).toEqual({ 'x-request-id': 'request-1' });
  });

  it('builds a bounded source context without adding secret material', () => {
    const context = buildWebhookContext({
      body,
      headers: { 'x-request-id': 'request-1' },
      receivedAt: '2026-07-13T00:00:00.000Z',
      deliveryId: 'delivery-1',
      sourceLabel: 'Pager',
      trigger: {
        id: 'trigger-1',
        name: 'Escalate',
        description: null,
        triggerCount: 2,
        projectId: 'project-1',
      },
      projectName: 'SAM',
      executionId: 'execution-1',
      sequenceNumber: 5,
    });
    expect(context.webhook.payload).toBe(canonicalJson(body));
    expect(context.trigger.fireCount).toBe('3');
    expect(context.execution.sequenceNumber).toBe('5');
  });
});
