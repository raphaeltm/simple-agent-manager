import { describe, expect, it } from 'vitest';

import { EngineCommandFailure, failureTail, processRunner } from './installer-engine-contract';

// The first full installs failed in the engine with no reason anywhere: the
// builder discarded the engine's output and the engine withheld every tool's
// stderr (staging, 2026-11-07). A failed command now carries a bounded,
// secret-scrubbed tail for the owner of the account.
describe('failure tail', () => {
  it('keeps the last lines and replaces exact secret values', () => {
    const env = {
      CF_API_TOKEN: 'cf-private-token-value',
      ACCOUNT_ID: 'a'.repeat(32),
      SHORT_KEY: 'abc',
    };
    const text = [
      ...Array.from({ length: 40 }, (_, index) => `line ${index}`),
      'request failed with cf-private-token-value for account ' + 'a'.repeat(32),
      'x'.repeat(500),
    ].join('\n');
    const tail = failureTail(text, env);
    expect(tail).toHaveLength(30);
    expect(tail.join('\n')).not.toContain('cf-private-token-value');
    expect(tail.at(-2)).toBe(`request failed with [redacted] for account ${'a'.repeat(32)}`);
    expect(tail.at(-1)).toHaveLength(300);
  });

  it('attaches the scrubbed stdout and stderr tail to a real failed command', async () => {
    const env = { ...process.env, DEPLOY_TOKEN: 'deploy-private-token-123' };
    const error = await processRunner
      .run(
        {
          executable: process.execPath,
          args: [
            '-e',
            "console.log('stdout line'); console.error('stderr uses deploy-private-token-123'); process.exit(7)",
          ],
        },
        { cwd: process.cwd(), env, timeoutMs: 10000 }
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineCommandFailure);
    const failure = error as EngineCommandFailure;
    expect(failure.exitCode).toBe(7);
    expect(failure.tail).toEqual(['stdout line', 'stderr uses [redacted]']);
  });

  it('control: a successful command still returns only stdout', async () => {
    const output = await processRunner.run(
      { executable: process.execPath, args: ['-e', "console.log('ok'); console.error('hidden')"] },
      { cwd: process.cwd(), env: process.env, timeoutMs: 10000 }
    );
    expect(output).toBe('ok\n');
  });
});
