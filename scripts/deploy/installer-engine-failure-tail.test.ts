import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

// A clean install's migration step was SIGKILLed for exceeding the capture limit, but only
// `pnpm` died: `tsx` and `wrangler` kept running and printed "PASSED" before the failure
// surfaced (staging, 2026-11-07). Each case runs a real grandchild, as pnpm -> tsx does.
describe('stopping a command', () => {
  const grandchild = (script: string) => [
    '-e',
    `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(script)}], { stdio: 'inherit' })`,
  ];
  const lateMarker = (marker: string) =>
    `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'), 1500)`;
  const markerPath = () =>
    path.join(mkdtempSync(path.join(tmpdir(), 'engine-stop-')), 'grandchild-finished');

  it('stops the whole process group when output exceeds the capture limit', async () => {
    const marker = markerPath();
    const started = Date.now();
    const error = await processRunner
      .run(
        {
          executable: process.execPath,
          args: grandchild(`process.stdout.write('x'.repeat(4096)); ${lateMarker(marker)}`),
        },
        {
          cwd: process.cwd(),
          env: { ...process.env, INSTALLER_ENGINE_CAPTURE_MAX_BYTES: '1024' },
          timeoutMs: 10000,
        }
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineCommandFailure);
    expect((error as EngineCommandFailure).tail.at(-1)).toBe(
      'Stopped: command output exceeded the capture limit.'
    );
    expect(Date.now() - started).toBeLessThan(1500);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(existsSync(marker)).toBe(false);
  });

  it('stops the whole process group on timeout', async () => {
    const marker = markerPath();
    const error = await processRunner
      .run(
        { executable: process.execPath, args: grandchild(lateMarker(marker)) },
        { cwd: process.cwd(), env: process.env, timeoutMs: 300 }
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineCommandFailure);
    expect((error as EngineCommandFailure).tail.at(-1)).toBe('Stopped: the command timed out.');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(existsSync(marker)).toBe(false);
  });

  it('lets a progress-only command print past the capture limit', async () => {
    const output = await processRunner.run(
      { executable: process.execPath, args: grandchild("process.stdout.write('x'.repeat(4096))") },
      {
        cwd: process.cwd(),
        env: { ...process.env, INSTALLER_ENGINE_CAPTURE_MAX_BYTES: '1024' },
        timeoutMs: 10000,
        discardOutput: true,
      }
    );
    expect(output).toBe('');
  });
});
