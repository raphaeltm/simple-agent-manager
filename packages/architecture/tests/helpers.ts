import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach } from 'vitest';

const roots: string[] = [];

export async function makeFixture(): Promise<{ root: string; workspaceRoot: string }> {
  const root = await import('node:fs/promises').then((fs) =>
    fs.mkdtemp(path.join(tmpdir(), 'sam-architecture-'))
  );
  roots.push(root);
  const workspaceRoot = path.join(root, 'architecture');
  await mkdir(workspaceRoot, { recursive: true });
  return { root, workspaceRoot };
}

export async function writeFixtureFile(
  root: string,
  relativePath: string,
  content: string
): Promise<void> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

export async function makeEscapingSymlink(
  root: string,
  relativePath: string,
  target: string
): Promise<void> {
  const linkPath = path.join(root, relativePath);
  await mkdir(path.dirname(linkPath), { recursive: true });
  await symlink(target, linkPath);
}

afterEach(async () => {
  const fs = await import('node:fs/promises');
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});
