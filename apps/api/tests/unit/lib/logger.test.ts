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
  test('serializes Error with message and name', () => {
    const err = new Error('something broke');
    const result = serializeError(err);
    expect(result.error).toBe('something broke');
    expect(result.errorName).toBe('Error');
    expect(result.stack).toBeDefined();
  });

  test('serializes Error with cause', () => {
    const cause = new Error('root cause');
    const err = new Error('wrapper', { cause });
    const result = serializeError(err);
    expect(result.error).toBe('wrapper');
    expect(result.cause).toBe('root cause');
  });

  test('serializes Error with non-Error cause', () => {
    const err = new Error('wrapper', { cause: 'string cause' });
    const result = serializeError(err);
    expect(result.cause).toBe('string cause');
  });

  test('serializes non-Error values as string', () => {
    expect(serializeError('plain string')).toEqual({ error: 'plain string' });
    expect(serializeError(42)).toEqual({ error: '42' });
    expect(serializeError(null)).toEqual({ error: 'null' });
    expect(serializeError(undefined)).toEqual({ error: 'undefined' });
  });

  test('serializes Error subclass', () => {
    const err = new TypeError('invalid type');
    const result = serializeError(err);
    expect(result.error).toBe('invalid type');
    expect(result.errorName).toBe('TypeError');
  });
});
