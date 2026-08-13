import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../src/cli';
import { makeFixture, writeFixtureFile } from './helpers';

describe('architecture CLI', () => {
  it('validates and prints JSON summaries', async () => {
    const fixture = await makeFixture();
    await writeFixtureFile(
      fixture.workspaceRoot,
      'model.yaml',
      `
version: 1
name: CLI
elements:
  - id: api
    kind: system
    title: API
`
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      runCli(['validate', '--workspace', fixture.workspaceRoot, '--repo', fixture.root, '--json'])
    ).resolves.toBe(0);
    await expect(
      runCli(['summary', '--workspace', fixture.workspaceRoot, '--repo', fixture.root, '--json'])
    ).resolves.toBe(0);

    const summary = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as { counts: { elements: number } };
    expect(summary.counts.elements).toBe(1);
    log.mockRestore();
  });

  it('returns a clear placeholder for serve', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(runCli(['serve'])).resolves.toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('delegated to the later local server/browser slice'));
    error.mockRestore();
  });
});
