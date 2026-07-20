import { beforeEach,describe, expect, test, vi } from 'vitest';

import { createModuleLogger, serializeError } from '../../../src/lib/logger';

describe('createModuleLogger', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test('prefixes event names with module name', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const log = createModuleLogger('transcribe');
    log.info('request_received', { size: 42 });

    expect(spy).toHaveBeenCalledOnce();
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.event).toBe('transcribe.request_received');
    expect(entry.level).toBe('info');
    expect(entry.size).toBe(42);
  });

  test('all log levels use the correct console method', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const log = createModuleLogger('auth');
    log.debug('check');
    log.info('login');
    log.warn('rate_limit');
    log.error('failure');

    expect(debugSpy).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();

    expect(JSON.parse(debugSpy.mock.calls[0][0] as string).event).toBe('auth.check');
    expect(JSON.parse(logSpy.mock.calls[0][0] as string).event).toBe('auth.login');
    expect(JSON.parse(warnSpy.mock.calls[0][0] as string).event).toBe('auth.rate_limit');
    expect(JSON.parse(errorSpy.mock.calls[0][0] as string).event).toBe('auth.failure');
  });
});

describe('serializeError', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test('serializes Error with redacted message and no stack', () => {
    const err = new Error('something broke with token sam_secret_123');
    const result = serializeError(err);
    expect(result.error).toBe('[REDACTED_ERROR_MESSAGE]');
    expect(result.errorName).toBe('Error');
    expect(result.stack).toBeUndefined();
  });

  test('serializes Error cause without raw Error cause message', () => {
    const cause = new Error('root cause with cookie session=secret');
    const err = new Error('wrapper', { cause });
    const result = serializeError(err);
    expect(result.error).toBe('[REDACTED_ERROR_MESSAGE]');
    expect(result.cause).toBe('[REDACTED_ERROR_MESSAGE]');
  });

  test('serializes non-Error cause with token-like values redacted', () => {
    const err = new Error('wrapper', { cause: 'string cause Bearer abc.def.ghi' });
    const result = serializeError(err);
    expect(result.cause).toBe('string cause [REDACTED]');
  });

  test('serializes non-Error values as string with token-like values redacted', () => {
    expect(serializeError('plain string')).toEqual({ error: 'plain string' });
    expect(serializeError('failed for sk-testtoken')).toEqual({ error: 'failed for [REDACTED]' });
    expect(serializeError(42)).toEqual({ error: '42' });
    expect(serializeError(null)).toEqual({ error: 'null' });
    expect(serializeError(undefined)).toEqual({ error: 'undefined' });
  });

  test('serializes Error subclass', () => {
    const err = new TypeError('invalid type');
    const result = serializeError(err);
    expect(result.error).toBe('[REDACTED_ERROR_MESSAGE]');
    expect(result.errorName).toBe('TypeError');
  });

  test('redacts sensitive log keys and token-like values before emitting', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = createModuleLogger('auth');

    log.error('failure', {
      authorization: 'Bearer secret-token',
      nested: {
        cookie: 'session=secret',
        note: 'failed for sk-testtoken',
      },
      safe: 'kept',
    });

    expect(spy).toHaveBeenCalledOnce();
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.authorization).toBe('[REDACTED]');
    expect(entry.nested.cookie).toBe('[REDACTED]');
    expect(entry.nested.note).toBe('failed for [REDACTED]');
    expect(entry.safe).toBe('kept');
  });
});
