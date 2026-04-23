import { describe, expect, it } from 'vitest';

import { ProviderError } from '../../src/types';

describe('ProviderError.toJSON', () => {
  it('serializes all fields to a plain object', () => {
    const err = new ProviderError('hetzner', 404, 'Server not found');
    const json = err.toJSON();

    expect(json).toEqual({
      name: 'ProviderError',
      message: 'Server not found',
      provider: 'hetzner',
      statusCode: 404,
      cause: undefined,
    });
  });

  it('serializes cause when it is an Error', () => {
    const cause = new Error('connection refused');
    const err = new ProviderError('scaleway', 500, 'API failure', { cause });
    const json = err.toJSON();

    expect(json.cause).toBe('connection refused');
  });

  it('serializes cause when it is a non-Error value', () => {
    const err = new ProviderError('hetzner', undefined, 'Unknown error', {
      cause: 'raw string cause' as unknown as Error,
    });
    const json = err.toJSON();

    expect(json.cause).toBe('raw string cause');
  });

  it('handles undefined statusCode', () => {
    const err = new ProviderError('gcp', undefined, 'Timeout');
    const json = err.toJSON();

    expect(json.statusCode).toBeUndefined();
    expect(json.provider).toBe('gcp');
    expect(json.message).toBe('Timeout');
  });

  it('makes JSON.stringify produce a useful string instead of empty object', () => {
    const err = new ProviderError('hetzner', 503, 'Service unavailable');
    const serialized = JSON.stringify(err);
    const parsed = JSON.parse(serialized);

    expect(parsed.name).toBe('ProviderError');
    expect(parsed.message).toBe('Service unavailable');
    expect(parsed.provider).toBe('hetzner');
    expect(parsed.statusCode).toBe(503);
  });

  it('includes cause.message in JSON.stringify output when cause is Error', () => {
    const cause = new Error('ECONNRESET');
    const err = new ProviderError('scaleway', 502, 'Gateway error', { cause });
    const serialized = JSON.stringify(err);
    const parsed = JSON.parse(serialized);

    expect(parsed.cause).toBe('ECONNRESET');
  });
});
