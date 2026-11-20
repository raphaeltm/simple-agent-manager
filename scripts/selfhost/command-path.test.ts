import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { commandPath } from './command-path';

function tool(dir: string, name: string, mode = 0o755): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\n');
  chmodSync(path, mode);
  return path;
}

describe('commandPath', () => {
  const root = mkdtempSync(join(tmpdir(), 'command-path-'));

  it('returns the first executable match in an absolute PATH entry', () => {
    const first = tool(join(root, 'a'), 'pnpm');
    tool(join(root, 'b'), 'pnpm');
    expect(commandPath('pnpm', [join(root, 'a'), join(root, 'b')].join(delimiter))).toBe(first);
  });

  it('skips relative and empty PATH entries, so the working directory cannot supply a tool', () => {
    const real = tool(join(root, 'bin'), 'docker');
    tool(join(process.cwd(), '.tmp', 'command-path-relative'), 'docker');
    const pathEnv = ['', '.', '.tmp/command-path-relative', join(root, 'bin')].join(delimiter);
    expect(commandPath('docker', pathEnv)).toBe(real);
  });

  it('skips a match that is not executable', () => {
    tool(join(root, 'noexec'), 'bash', 0o644);
    const real = tool(join(root, 'exec'), 'bash');
    const pathEnv = [join(root, 'noexec'), join(root, 'exec')].join(delimiter);
    expect(commandPath('bash', pathEnv)).toBe(real);
  });

  it('returns an absolute command unchanged and names a missing tool', () => {
    expect(commandPath('/usr/bin/env', '')).toBe('/usr/bin/env');
    expect(() => commandPath('no-such-tool', join(root, 'a'))).toThrow(
      'no-such-tool was not found on PATH'
    );
  });
});
