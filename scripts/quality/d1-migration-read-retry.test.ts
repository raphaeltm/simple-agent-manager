import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { executeD1VerificationRead } from '../deploy/d1-migration-read-retry';
import { ExecD1MigrationSafetyRunner } from '../deploy/d1-migration-safety';

const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync }));

const COMMAND = 'synthetic-reader';
const ARGS = ['--command', 'SELECT synthetic_private_value'];
const OUTPUT = '[{"results":[{"count":7}]}]\n';

function failure(stream: 'stdout' | 'stderr' = 'stdout', code: unknown = 7429) {
  return Object.assign(new Error('synthetic_private_error'), {
    [stream]: JSON.stringify({ error: { code, message: 'synthetic_private_detail' } }),
  });
}

function dependencies(env: Record<string, string | undefined> = {}) {
  return {
    execute: vi.fn<(command: string, args: string[], options?: unknown) => string>(() => OUTPUT),
    sleep: vi.fn<(ms: number) => void>(),
    warn: vi.fn<(message: string) => void>(),
    env,
  };
}

function run(deps: ReturnType<typeof dependencies>) {
  return executeD1VerificationRead(COMMAND, ARGS, { cwd: '/synthetic' }, deps);
}

function expectSafe(value: unknown) {
  const text = String(value);
  for (const privateText of [
    ...ARGS,
    COMMAND,
    'synthetic_private_error',
    'synthetic_private_detail',
  ]) {
    expect(text).not.toContain(privateText);
  }
}

describe('bounded D1 migration verification read retry', () => {
  it('returns successful JSON text untouched and forwards command arguments and options', () => {
    const deps = dependencies();
    expect(run(deps)).toBe(OUTPUT);
    expect(deps.execute).toHaveBeenCalledOnce();
    expect(deps.execute).toHaveBeenCalledWith(
      COMMAND,
      ARGS,
      expect.objectContaining({ cwd: '/synthetic' })
    );
    expect(deps.sleep).not.toHaveBeenCalled();
    expect(deps.warn).not.toHaveBeenCalled();
  });

  it.each(['stdout', 'stderr'] as const)(
    'retries structured resource limits in %s and then succeeds',
    (stream) => {
      const deps = dependencies();
      deps.execute.mockImplementationOnce(() => {
        throw failure(stream);
      });
      expect(run(deps)).toBe(OUTPUT);
      expect(deps.execute).toHaveBeenCalledTimes(2);
      expect(deps.sleep).toHaveBeenCalledExactlyOnceWith(10_000);
      expect(deps.warn).toHaveBeenCalledOnce();
      expect(String(deps.warn.mock.calls)).toContain('resource_limit');
      expectSafe(deps.warn.mock.calls);
    }
  );

  it('exhausts the default three attempts with two delays and preserves the original cause privately', () => {
    const deps = dependencies();
    const original = failure();
    deps.execute.mockImplementation(() => {
      throw original;
    });
    let caught: unknown;
    try {
      run(deps);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).cause).toBe(original);
    expectSafe((caught as Error).message);
    expectSafe(deps.warn.mock.calls);
    expect(deps.execute).toHaveBeenCalledTimes(3);
    expect(deps.sleep.mock.calls).toEqual([[10_000], [10_000]]);
  });

  it.each([
    new Error('synthetic_private_error 7429'),
    Object.assign(new Error('synthetic_private_error'), { stdout: 'not JSON 7429' }),
    Object.assign(new Error('synthetic_private_error'), { stdout: '{"message":"7429"}' }),
    failure('stdout', 9999),
    failure('stderr', '7429'),
  ])('fails unknown or unstructured errors once without exposing captured output', (original) => {
    const deps = dependencies();
    deps.execute.mockImplementation(() => {
      throw original;
    });
    let caught: unknown;
    try {
      run(deps);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).cause).toBe(original);
    expectSafe((caught as Error).message);
    expect(deps.execute).toHaveBeenCalledOnce();
    expect(deps.sleep).not.toHaveBeenCalled();
    expectSafe(deps.warn.mock.calls);
  });

  it('honors bounded configured attempts and delay, including zero delay', () => {
    const deps = dependencies({
      D1_MIGRATION_READ_ATTEMPTS: '5',
      D1_MIGRATION_READ_RETRY_DELAY_MS: '0',
    });
    deps.execute.mockImplementation(() => {
      throw failure();
    });
    expect(() => run(deps)).toThrow();
    expect(deps.execute).toHaveBeenCalledTimes(5);
    expect(deps.sleep.mock.calls.every(([delay]) => delay === 0)).toBe(true);
  });

  it('supports a single attempt and the maximum permitted delay', () => {
    const deps = dependencies({
      D1_MIGRATION_READ_ATTEMPTS: '1',
      D1_MIGRATION_READ_RETRY_DELAY_MS: '60000',
    });
    deps.execute.mockImplementation(() => {
      throw failure();
    });
    expect(() => run(deps)).toThrow();
    expect(deps.execute).toHaveBeenCalledOnce();
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it.each([
    ['D1_MIGRATION_READ_ATTEMPTS', '0'],
    ['D1_MIGRATION_READ_ATTEMPTS', '6'],
    ['D1_MIGRATION_READ_ATTEMPTS', '1.5'],
    ['D1_MIGRATION_READ_ATTEMPTS', 'invalid'],
    ['D1_MIGRATION_READ_RETRY_DELAY_MS', '-1'],
    ['D1_MIGRATION_READ_RETRY_DELAY_MS', '60001'],
    ['D1_MIGRATION_READ_RETRY_DELAY_MS', 'NaN'],
    ['D1_MIGRATION_READ_RETRY_DELAY_MS', '1.5'],
  ])('rejects invalid %s=%s before invoking the read', (key, value) => {
    const deps = dependencies({ [key]: value });
    expect(() => run(deps)).toThrow();
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.sleep).not.toHaveBeenCalled();
  });
});

describe('migration safety runner subprocess boundary', () => {
  beforeEach(() => {
    execFileSync.mockReset();
    vi.stubEnv('D1_MIGRATION_READ_ATTEMPTS', '3');
    vi.stubEnv('D1_MIGRATION_READ_RETRY_DELAY_MS', '0');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('retries structured resource limits through the real JSON runner and parses successful output', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sleep = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
    execFileSync.mockImplementationOnce(() => {
      throw failure('stderr');
    });
    execFileSync.mockReturnValueOnce(OUTPUT);
    const runner = new ExecD1MigrationSafetyRunner();
    expect(runner.executeJson(COMMAND, ARGS, { cwd: '/synthetic' })).toEqual([
      { results: [{ count: 7 }] },
    ]);
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(execFileSync).toHaveBeenNthCalledWith(2, COMMAND, ARGS, {
      cwd: '/synthetic',
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(sleep).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expectSafe(warn.mock.calls);
  });

  it('blocks malformed successful JSON without retrying the read', () => {
    const sleep = vi.spyOn(Atomics, 'wait');
    execFileSync.mockReturnValueOnce('malformed synthetic output');
    expect(() => new ExecD1MigrationSafetyRunner().executeJson(COMMAND, ARGS)).toThrow();
    expect(execFileSync).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('never retries writes even when the subprocess reports structured resource limits', () => {
    const sleep = vi.spyOn(Atomics, 'wait');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const original = failure('stdout');
    execFileSync.mockImplementation(() => {
      throw original;
    });
    expect(() =>
      new ExecD1MigrationSafetyRunner().execute(COMMAND, ['synthetic-write'], {
        cwd: '/synthetic',
        stdio: 'pipe',
      })
    ).toThrow(original);
    expect(execFileSync).toHaveBeenCalledExactlyOnceWith(COMMAND, ['synthetic-write'], {
      cwd: '/synthetic',
      stdio: 'pipe',
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
