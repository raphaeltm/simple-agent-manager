import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../src/cli';
import { loadArchitectureWorkspace } from '../src/loader';
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

    const summary = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      counts: { elements: number };
    };
    expect(summary.counts.elements).toBe(1);
    log.mockRestore();
  });

  it('validates serve port input', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(runCli(['serve', '--port', 'not-a-port'])).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('--port must be an integer'));
    error.mockRestore();
  });

  it('runs show, inbox, reply, and impact commands against real workspace files', async () => {
    const fixture = await makeFixture();
    await writeFixtureFile(fixture.root, 'src/api.ts', 'export const api = true;\n');
    await writeFixtureFile(
      fixture.workspaceRoot,
      'model.yaml',
      `version: 1
name: CLI commands
threadsDir: discussions
elements:
  - id: api
    kind: system
    title: API
    sourceRefs:
      - path: src/api.ts
`
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await expect(
        runCli([
          'show',
          'api',
          '--workspace',
          fixture.workspaceRoot,
          '--repo',
          fixture.root,
          '--json',
        ])
      ).resolves.toBe(0);
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
        element: { id: 'api' },
      });

      await expect(
        runCli([
          'reply',
          '--workspace',
          fixture.workspaceRoot,
          '--repo',
          fixture.root,
          '--target',
          'api',
          '--title',
          'CLI question',
          '--body',
          'What happens?',
          '--json',
        ])
      ).resolves.toBe(0);
      const created = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
        artifactPath: string;
        thread: { id: string };
      };
      expect(created.artifactPath).toContain('architecture/discussions/');
      await expect(
        access(`${fixture.workspaceRoot}/discussions/${created.thread.id}.thread.md`)
      ).resolves.toBeUndefined();
      await expect(
        runCli([
          'reply',
          '--workspace',
          fixture.workspaceRoot,
          '--thread',
          created.thread.id,
          '--body',
          'Answer',
          '--json',
        ])
      ).resolves.toBe(0);
      await expect(
        runCli(['inbox', '--workspace', fixture.workspaceRoot, '--repo', fixture.root, '--json'])
      ).resolves.toBe(0);
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toHaveLength(1);
      await expect(
        runCli([
          'impact',
          'src/api.ts',
          '--workspace',
          fixture.workspaceRoot,
          '--repo',
          fixture.root,
          '--json',
        ])
      ).resolves.toBe(0);
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
        impacted: [expect.objectContaining({ id: 'api' })],
      });
    } finally {
      log.mockRestore();
    }
  });

  it('serializes replies made by separate CLI processes', async () => {
    const fixture = await makeFixture();
    await writeFixtureFile(
      fixture.workspaceRoot,
      'model.yaml',
      'version: 1\nname: Concurrent CLI\nelements:\n  - id: api\n    kind: system\n    title: API\n'
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await expect(
        runCli([
          'reply',
          '--workspace',
          fixture.workspaceRoot,
          '--repo',
          fixture.root,
          '--target',
          'api',
          '--title',
          'Concurrent question',
          '--body',
          'Initial body',
          '--json',
        ])
      ).resolves.toBe(0);
      const created = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
        thread: { id: string };
      };
      const args = [
        '--import',
        'tsx',
        path.resolve(process.cwd(), 'src/cli.ts'),
        'reply',
        '--workspace',
        fixture.workspaceRoot,
        '--repo',
        fixture.root,
        '--thread',
        created.thread.id,
        '--body',
        'Concurrent answer',
        '--json',
      ];

      await Promise.all([runProcess(args), runProcess(args)]);

      const loaded = await loadArchitectureWorkspace({
        workspaceRoot: fixture.workspaceRoot,
        repoRoot: fixture.root,
      });
      expect(loaded.diagnostics).toEqual([]);
      const messages = loaded.workspace.threads[0]?.messages ?? [];
      expect(messages).toHaveLength(3);
      expect(new Set(messages.map((message) => message.id)).size).toBe(3);
    } finally {
      log.mockRestore();
    }
  });
});

const execFileAsync = promisify(execFile);

async function runProcess(args: string[]): Promise<void> {
  const result = await execFileAsync(process.execPath, args, {
    cwd: process.cwd(),
  });
  expect(JSON.parse(result.stdout)).toHaveProperty('message.id');
}
