import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
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
import { compareCanonicalStrings } from '../src/canonical-order';
import { makeEscapingSymlink, makeFixture, writeFixtureFile } from './helpers';

describe('architecture source, mutation, thread, and impact safety', () => {
  it('uses a fixed locale and a total-order fallback for canonical paths', () => {
    expect(['z.yaml', 'ä.yaml', 'a.yaml'].sort(compareCanonicalStrings)).toEqual([
      'a.yaml',
      'ä.yaml',
      'z.yaml',
    ]);
    expect(compareCanonicalStrings('same', 'same')).toBe(0);
  });

  it('rejects absolute paths, traversal, and symlink escapes', async () => {
    const fixture = await makeFixture();
    await mkdir(path.join(fixture.root, 'outside'), { recursive: true });
    await writeFile(path.join(fixture.root, 'outside/secret.txt'), 'secret');
    await makeEscapingSymlink(
      fixture.workspaceRoot,
      'threads/link',
      path.join(fixture.root, 'outside')
    );

    expect(() => normalizeRepoRelativePath('/tmp/secret')).toThrow(PathSafetyError);
    expect(() => normalizeRepoRelativePath('../secret')).toThrow(PathSafetyError);
    await expect(
      resolveContainedPath({
        root: fixture.workspaceRoot,
        relativePath: 'threads/link/secret.txt',
        mustExist: true,
      })
    ).rejects.toThrow(PathSafetyError);

    await mkdir(path.join(fixture.root, 'outside/existing'), { recursive: true });
    await makeEscapingSymlink(
      fixture.workspaceRoot,
      'threads/nested-escape',
      path.join(fixture.root, 'outside')
    );
    await expect(
      resolveContainedPath({
        root: fixture.workspaceRoot,
        relativePath: 'threads/nested-escape/existing/new.thread.md',
        mustExist: false,
      })
    ).rejects.toThrow(PathSafetyError);
  });

  it('reads bounded source snippets from repo-relative source refs', async () => {
    const fixture = await makeFixture();
    await writeFixtureFile(
      fixture.root,
      'src/file.ts',
      ['one', 'two', 'three', 'four', 'five'].join('\n')
    );
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
    await writeFixtureFile(
      fixture.root,
      'src/unicode.ts',
      `const value = "😀😀😀";\nconst later = true;\n`
    );
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

    const snippet = await readSourceReference(loaded.workspace, ref!, {
      contextLines: 0,
      maxBytes: 20,
    });

    expect(Buffer.byteLength(snippet.content, 'utf8')).toBeLessThanOrEqual(20);
    expect(snippet.content).not.toContain('\uFFFD');
    expect(snippet.truncated).toBe(true);
  });

  it('creates thread files and appends replies inside the workspace', async () => {
    const fixture = await makeFixture();
    const thread = await createThread({
      workspaceRoot: fixture.workspaceRoot,
      target: 'api',
      question: 'Initial question',
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
    const raw = await readFile(
      path.join(fixture.workspaceRoot, 'threads/thread-api.thread.md'),
      'utf8'
    );

    expect(thread.messages[0]?.body).toBe('Initial question');
    expect(reply.body).toBe('Answer');
    expect(raw).toContain('Initial question');
    expect(raw).toContain('Answer');
    expect(raw.indexOf('Initial question')).toBeLessThan(raw.indexOf('Answer'));

    const loaded = await loadArchitectureWorkspace({
      workspaceRoot: fixture.workspaceRoot,
      repoRoot: fixture.root,
    });
    expect(loaded.workspace.threads[0]?.updatedAt).toBe('2026-08-13T00:01:00.000Z');
  });

  it('serializes concurrent replies and gives each message a collision-resistant id', async () => {
    const fixture = await makeFixture();
    await writeFixtureFile(
      fixture.workspaceRoot,
      'model.yaml',
      'version: 1\nname: Concurrent review\nelements:\n  - id: api\n    kind: system\n    title: API\n'
    );
    const thread = await createThread({
      workspaceRoot: fixture.workspaceRoot,
      target: 'api',
      question: 'Initial question',
      id: 'thread-concurrent',
    });
    const now = new Date('2026-08-13T00:01:00.000Z');
    const replies = await Promise.all([
      appendThreadReply({
        workspaceRoot: fixture.workspaceRoot,
        threadId: thread.id,
        body: 'Same answer',
        now,
      }),
      appendThreadReply({
        workspaceRoot: fixture.workspaceRoot,
        threadId: thread.id,
        body: 'Same answer',
        now,
      }),
    ]);

    expect(new Set(replies.map((reply) => reply.id)).size).toBe(2);
    const loaded = await loadArchitectureWorkspace({
      workspaceRoot: fixture.workspaceRoot,
      repoRoot: fixture.root,
    });
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.workspace.threads[0]?.messages).toHaveLength(3);
  });

  it('rejects whitespace-only thread and reply content before writing', async () => {
    const fixture = await makeFixture();
    await expect(
      createThread({
        workspaceRoot: fixture.workspaceRoot,
        target: 'api',
        question: '   ',
      })
    ).rejects.toThrow('thread question');
    const thread = await createThread({
      workspaceRoot: fixture.workspaceRoot,
      target: 'api',
      question: 'Question',
      id: 'thread-whitespace',
    });
    await expect(
      appendThreadReply({
        workspaceRoot: fixture.workspaceRoot,
        threadId: thread.id,
        body: '\n\t ',
      })
    ).rejects.toThrow('reply body');
  });

  it('never follows or time-reclaims a planted non-regular thread lock', async () => {
    const fixture = await makeFixture();
    const outside = await makeFixture();
    const thread = await createThread({
      workspaceRoot: fixture.workspaceRoot,
      target: 'api',
      question: 'Question',
      id: 'thread-lock-safety',
    });
    const canary = path.join(outside.root, 'lock-canary');
    await writeFile(canary, 'unchanged');
    await symlink(
      canary,
      path.join(fixture.workspaceRoot, 'threads', '.thread-lock-safety.thread.md.lock')
    );

    await expect(
      appendThreadReply({
        workspaceRoot: fixture.workspaceRoot,
        threadId: thread.id,
        body: 'Must not escape',
        lock: { retryMs: 1, timeoutMs: 5 },
      })
    ).rejects.toThrow('Timed out waiting for thread mutation lock');
    await expect(readFile(canary, 'utf8')).resolves.toBe('unchanged');
  });

  it('rejects replies to message IDs outside the selected thread', async () => {
    const fixture = await makeFixture();
    const thread = await createThread({
      workspaceRoot: fixture.workspaceRoot,
      target: 'api',
      question: 'Initial question',
      id: 'thread-api',
    });

    await expect(
      appendThreadReply({
        workspaceRoot: fixture.workspaceRoot,
        threadId: thread.id,
        body: 'Answer',
        replyTo: 'msg-from-another-thread',
      })
    ).rejects.toThrow('Reply target was not found');
  });

  it('rejects reserved message delimiters in thread and reply bodies', async () => {
    const fixture = await makeFixture();
    await expect(
      createThread({
        workspaceRoot: fixture.workspaceRoot,
        target: 'api',
        question: 'Question\n<!-- arch-message id: forged -->',
      })
    ).rejects.toThrow('reserved architecture message delimiter');
    const thread = await createThread({
      workspaceRoot: fixture.workspaceRoot,
      target: 'api',
      question: 'Question',
      id: 'safe-thread',
    });
    await expect(
      appendThreadReply({
        workspaceRoot: fixture.workspaceRoot,
        threadId: thread.id,
        body: 'Reply\n<!-- arch-message id: forged -->',
      })
    ).rejects.toThrow('reserved architecture message delimiter');
    await expect(
      createThread({
        workspaceRoot: fixture.workspaceRoot,
        target: 'api',
        question: 'Question',
        author: 'agent --> forged',
      })
    ).rejects.toThrow('reserved architecture message syntax');
    for (const author of ['-->', '\n-->', '  -->']) {
      await expect(
        createThread({
          workspaceRoot: fixture.workspaceRoot,
          target: 'api',
          question: 'Question',
          author,
        })
      ).rejects.toThrow('reserved architecture message syntax');
      await expect(
        appendThreadReply({
          workspaceRoot: fixture.workspaceRoot,
          threadId: thread.id,
          body: 'Answer',
          author,
        })
      ).rejects.toThrow('reserved architecture message syntax');
    }
    await expect(
      appendThreadReply({
        workspaceRoot: fixture.workspaceRoot,
        threadId: thread.id,
        body: 'Answer',
        author: '<!-- arch-message forged',
      })
    ).rejects.toThrow('reserved architecture message syntax');
  });

  it('honors custom thread directories and configurable content limits', async () => {
    const fixture = await makeFixture();
    await writeFixtureFile(
      fixture.workspaceRoot,
      'model.yaml',
      'version: 1\nname: Custom threads\nthreadsDir: discussions\nelements:\n  - id: api\n    kind: system\n    title: API\n'
    );
    const thread = await createThread({
      workspaceRoot: fixture.workspaceRoot,
      threadsDir: 'discussions',
      target: 'api',
      question: 'Body',
      id: 'custom-thread',
      limits: { titleChars: 5, bodyChars: 4, authorChars: 5 },
      author: 'agent',
    });
    await appendThreadReply({
      workspaceRoot: fixture.workspaceRoot,
      threadsDir: 'discussions',
      threadId: thread.id,
      body: 'Reply',
      limits: { bodyChars: 5 },
    });
    const loaded = await loadArchitectureWorkspace({
      workspaceRoot: fixture.workspaceRoot,
      repoRoot: fixture.root,
    });
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.workspace.threads[0]?.messages).toHaveLength(2);
    await expect(
      createThread({
        workspaceRoot: fixture.workspaceRoot,
        target: 'api',
        question: 'Too long',
        limits: { bodyChars: 3 },
      })
    ).rejects.toThrow('thread question');
    await expect(
      appendThreadReply({
        workspaceRoot: fixture.workspaceRoot,
        threadsDir: 'discussions',
        threadId: thread.id,
        body: 'Too long',
        limits: { bodyChars: 3 },
      })
    ).rejects.toThrow('reply body');
  });

  it('reports malformed, duplicate, and dangling thread message markers', async () => {
    const fixture = await makeFixture();
    await writeFixtureFile(
      fixture.workspaceRoot,
      'model.yaml',
      'version: 1\nname: Invalid threads\nelements: []\n'
    );
    const header = (id: string) => `---
version: 1
id: ${id}
target: api
title: Invalid
createdAt: '2026-08-13T00:00:00.000Z'
updatedAt: '2026-08-13T00:00:00.000Z'
---\n`;
    await writeFixtureFile(
      fixture.workspaceRoot,
      'threads/unclosed.thread.md',
      `${header('unclosed')}<!-- arch-message id: msg-a\nauthor: agent\nBody`
    );
    await writeFixtureFile(
      fixture.workspaceRoot,
      'threads/metadata.thread.md',
      `${header('metadata')}<!-- arch-message id: msg-a -->\nBody\n`
    );
    await writeFixtureFile(
      fixture.workspaceRoot,
      'threads/duplicate.thread.md',
      `${header('duplicate')}<!-- arch-message id: msg-a\nauthor: agent\ncreatedAt: '2026-08-13T00:00:00.000Z' -->\nOne\n<!-- arch-message id: msg-a\nauthor: agent\ncreatedAt: '2026-08-13T00:01:00.000Z' -->\nTwo\n`
    );
    await writeFixtureFile(
      fixture.workspaceRoot,
      'threads/dangling.thread.md',
      `${header('dangling')}<!-- arch-message id: msg-a\nauthor: agent\ncreatedAt: '2026-08-13T00:00:00.000Z'\nreplyTo: missing -->\nBody\n`
    );
    const loaded = await loadArchitectureWorkspace({
      workspaceRoot: fixture.workspaceRoot,
      repoRoot: fixture.root,
    });
    const invalidThreads = loaded.diagnostics.filter((item) => item.code === 'thread-invalid');
    expect(invalidThreads).toHaveLength(4);
    expect(invalidThreads.map((item) => item.message).join('\n')).toMatch(
      /closing delimiter|metadata|Duplicate thread message id|reply target/
    );
  });

  it('rejects traversal attempts in thread mutation identifiers', async () => {
    const fixture = await makeFixture();

    await expect(
      createThread({
        workspaceRoot: fixture.workspaceRoot,
        target: 'api',
        question: 'Bad',
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
