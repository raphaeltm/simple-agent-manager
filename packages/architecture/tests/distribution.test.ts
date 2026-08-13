import { execFile } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { makeFixture, writeFixtureFile } from './helpers';

const execFileAsync = promisify(execFile);

describe('built architecture distribution', () => {
  it('imports the packaged entry point and executes the packaged CLI', async () => {
    const packageRoot = process.cwd();
    const exports = (await import(pathToFileURL(path.join(packageRoot, 'dist/index.js')).href)) as {
      loadArchitectureWorkspace?: unknown;
    };
    expect(exports.loadArchitectureWorkspace).toBeTypeOf('function');

    const fixture = await makeFixture();
    await writeFixtureFile(
      fixture.workspaceRoot,
      'model.yaml',
      'version: 1\nname: Distribution fixture\nelements: []\n'
    );
    const result = await execFileAsync(
      process.execPath,
      [
        path.join(packageRoot, 'dist/cli.js'),
        'summary',
        '--workspace',
        fixture.workspaceRoot,
        '--repo',
        fixture.root,
        '--json',
      ],
      { cwd: packageRoot }
    );
    expect(JSON.parse(result.stdout)).toMatchObject({ name: 'Distribution fixture' });
  });

  it('emits parseable JSON through the documented silent root command', async () => {
    const repoRoot = path.resolve(process.cwd(), '../..');
    const result = await execFileAsync(
      'corepack',
      ['pnpm', '--silent', 'architecture:summary', '--', '--json'],
      { cwd: repoRoot }
    );
    expect(JSON.parse(result.stdout)).toMatchObject({ name: 'Simple Agent Manager' });
  });
});
