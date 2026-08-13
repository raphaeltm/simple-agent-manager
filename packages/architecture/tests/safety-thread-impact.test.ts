import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  appendThreadReply,
  createThread,
  loadArchitectureWorkspace,
  mapChangedPathsToArchitecture,
  normalizeRepoRelativePath,
  PathSafetyError,
  readSourceReference,
  resolveContainedPath,
} from '../src';
import { makeEscapingSymlink, makeFixture, writeFixtureFile } from './helpers';

describe('architecture source, mutation, thread, and impact safety', () => {
  it('rejects absolute paths, traversal, and symlink escapes', async () => {
    const fixture = await makeFixture();
    await mkdir(path.join(fixture.root, 'outside'), { recursive: true });
    await writeFile(path.join(fixture.root, 'outside/secret.txt'), 'secret');
    await makeEscapingSymlink(fixture.workspaceRoot, 'threads/link', path.join(fixture.root, 'outside'));

    expect(() => normalizeRepoRelativePath('/tmp/secret')).toThrow(PathSafetyError);
    expect(() => normalizeRepoRelativePath('../secret')).toThrow(PathSafetyError);
    await expect(
      resolveContainedPath({
        root: fixture.workspaceRoot,
        relativePath: 'threads/link/secret.txt',
        mustExist: true,
      })
    ).rejects.toThrow(PathSafetyError);
  });

  it('reads bounded source snippets from repo-relative source refs', async () => {
    const fixture = await makeFixture();
    await writeFixtureFile(fixture.root, 'src/file.ts', ['one', 'two', 'three', 'four', 'five'].join('\n'));
    await writeFixtureFile(
      fixture.workspaceRoot,
      'model.yaml',
      `
version: 1
name: Source
elements:
  - id: api
    kind: system
    title: API
    sourceRefs:
      - path: src/file.ts
        startLine: 3
        endLine: 3
`
    );
    const loaded = await loadArchitectureWorkspace({
      workspaceRoot: fixture.workspaceRoot,
      repoRoot: fixture.root,
    });
    const ref = loaded.workspace.elements[0]?.sourceRefs?.[0];
    expect(ref).toBeDefined();
    const snippet = await readSourceReference(loaded.workspace, ref!, { contextLines: 1 });
    expect(snippet).toMatchObject({ startLine: 2, endLine: 4, content: 'two\nthree\nfour' });
  });

  it('truncates source snippets at UTF-8 byte boundaries without reading full content into memory', async () => {
    const fixture = await makeFixture();
    await writeFixtureFile(fixture.root, 'src/unicode.ts', `const value = "😀😀😀";\nconst later = true;\n`);
    await writeFixtureFile(
      fixture.workspaceRoot,
      'model.yaml',
      `
version: 1
name: Source
elements:
  - id: api
    kind: system
    title: API
    sourceRefs:
      - path: src/unicode.ts
        startLine: 1
`
    );
    const loaded = await loadArchitectureWorkspace({
      workspaceRoot: fixture.workspaceRoot,
      repoRoot: fixture.root,
    });
    const ref = loaded.workspace.elements[0]?.sourceRefs?.[0];
    expect(ref).toBeDefined();

    const snippet = await readSourceReference(loaded.workspace, ref!, { contextLines: 0, maxBytes: 20 });

    expect(Buffer.byteLength(snippet.content, 'utf8')).toBeLessThanOrEqual(20);
    expect(snippet.content).not.toContain('\uFFFD');
    expect(snippet.truncated).toBe(true);
  });

  it('creates thread files and appends replies inside the workspace', async () => {
    const fixture = await makeFixture();
    const thread = await createThread({
      workspaceRoot: fixture.workspaceRoot,
      target: 'api',
      title: 'Clarify API',
      body: 'Initial question',
      author: 'tester',
      now: new Date('2026-08-13T00:00:00.000Z'),
      id: 'thread-api',
    });
    const reply = await appendThreadReply({
      workspaceRoot: fixture.workspaceRoot,
      threadId: thread.id,
      body: 'Answer',
      author: 'reviewer',
      now: new Date('2026-08-13T00:01:00.000Z'),
    });
    const raw = await readFile(path.join(fixture.workspaceRoot, 'threads/thread-api.thread.md'), 'utf8');

    expect(thread.messages[0]?.body).toBe('Initial question');
    expect(reply.body).toBe('Answer');
    expect(raw).toContain('Initial question');
    expect(raw).toContain('Answer');
    expect(raw.indexOf('Initial question')).toBeLessThan(raw.indexOf('Answer'));
  });

  it('rejects traversal attempts in thread mutation identifiers', async () => {
    const fixture = await makeFixture();

    await expect(
      createThread({
        workspaceRoot: fixture.workspaceRoot,
        target: 'api',
        title: 'Bad',
        body: 'Bad',
        id: '../outside',
      })
    ).rejects.toThrow();
    await expect(
      appendThreadReply({
        workspaceRoot: fixture.workspaceRoot,
        threadId: '../outside',
        body: 'Bad',
      })
    ).rejects.toThrow(PathSafetyError);
  });

  it('maps changed repo paths to referenced architecture records and reports broken refs', async () => {
    const fixture = await makeFixture();
    await writeFixtureFile(fixture.root, 'apps/api/src/index.ts', 'export {};\n');
    await writeFixtureFile(
      fixture.workspaceRoot,
      'model.yaml',
      `
version: 1
name: Impact
elements:
  - id: api
    kind: system
    title: API
    sourceRefs:
      - path: apps/api/src/index.ts
  - id: broken
    kind: component
    title: Broken
    sourceRefs:
      - path: missing.ts
relationships:
  - id: api-self
    from: api
    to: api
    sourceRefs:
      - path: apps/api
`
    );

    const loaded = await loadArchitectureWorkspace({
      workspaceRoot: fixture.workspaceRoot,
      repoRoot: fixture.root,
    });
    const report = await mapChangedPathsToArchitecture(loaded.workspace, ['apps/api/src/index.ts']);

    expect(report.impacted.map((record) => `${record.kind}:${record.id}`)).toEqual([
      'element:api',
      'relationship:api-self',
    ]);
    expect(report.brokenSourceRefs).toEqual([
      expect.objectContaining({ ownerKind: 'element', ownerId: 'broken', path: 'missing.ts' }),
    ]);
  });
});
