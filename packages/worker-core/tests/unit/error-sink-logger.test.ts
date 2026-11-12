import { afterEach, describe, expect, it, vi } from 'vitest';

import { createErrorSinkLogger, type LoggedErrorEntry } from '../../src/logger';

afterEach(() => {
  vi.restoreAllMocks();
});

function silenceConsole() {
  for (const method of ['log', 'debug', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
}

describe('createErrorSinkLogger', () => {
  it('hands error-level entries to the sink through waitUntil, with sanitized context', async () => {
    silenceConsole();
    const entries: LoggedErrorEntry[] = [];
    const pending: Promise<unknown>[] = [];
    const logger = createErrorSinkLogger(
      async (entry) => {
        entries.push(entry);
      },
      (promise) => pending.push(promise)
    );

    logger.error('api_failure', { path: '/api/test', authorization: 'Bearer abc.def' });
    await Promise.all(pending);

    expect(pending).toHaveLength(1);
    expect(entries).toEqual([
      { event: 'api_failure', context: { path: '/api/test', authorization: '[REDACTED]' } },
    ]);
    // The console line is still emitted.
    expect(console.error).toHaveBeenCalledOnce();
  });

  it('passes a null context when the entry has no details', async () => {
    silenceConsole();
    const sink = vi.fn(async () => undefined);
    const pending: Promise<unknown>[] = [];
    createErrorSinkLogger(sink, (promise) => pending.push(promise)).error('bare_failure');
    await Promise.all(pending);
    expect(sink).toHaveBeenCalledWith({ event: 'bare_failure', context: null });
  });

  it('never hands non-error levels to the sink', () => {
    silenceConsole();
    const sink = vi.fn(async () => undefined);
    const waitUntil = vi.fn();
    const logger = createErrorSinkLogger(sink, waitUntil);
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    expect(sink).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
    // Liveness: the entries did reach the console.
    expect(console.log).toHaveBeenCalledOnce();
  });

  it.each([
    ['no sink', null, vi.fn()],
    ['no waitUntil', vi.fn(async () => undefined), null],
  ] as const)('behaves like the plain logger with %s', (_label, sink, waitUntil) => {
    silenceConsole();
    createErrorSinkLogger(sink, waitUntil).error('failure', { a: 1 });
    expect(console.error).toHaveBeenCalledOnce();
    if (sink) expect(sink).not.toHaveBeenCalled();
    if (waitUntil) expect(waitUntil).not.toHaveBeenCalled();
  });
});
