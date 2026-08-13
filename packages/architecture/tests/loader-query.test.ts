import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getWorkspaceSummary,
  listUnresolvedInbox,
  loadArchitectureWorkspace,
  showElement,
} from '../src';
import { makeFixture, writeFixtureFile } from './helpers';

describe('architecture workspace loading and bounded queries', () => {
  it('loads YAML and Markdown deterministically with compact layout-free queries', async () => {
    const fixture = await makeFixture();
    await writeFixtureFile(fixture.root, 'apps/api/src/index.ts', 'export const api = true;\n');
    await writeFixtureFile(
      fixture.workspaceRoot,
      'manifest.yaml',
      `
version: 1
name: SAM Fixture
description: Test architecture
elements:
  - id: api
    kind: system
    title: API
    sourceRefs:
      - path: apps/api/src/index.ts
        startLine: 1
  - id: web
    kind: system
    title: Web
relationships:
  - id: web-calls-api
    from: web
    to: api
    type: http
    title: Web calls API
`
    );
    await writeFixtureFile(
      fixture.workspaceRoot,
      'nested/flow.md',
      `---
flows:
  - id: startup
    title: Startup
    steps:
      - id: call
        title: Browser calls API
        element: web
        relationship: web-calls-api
stateMachines:
  - id: session-state
    title: Session state
    element: api
    states:
      - id: queued
        title: Queued
      - id: running
        title: Running
    transitions:
      - from: queued
        to: running
        relationship: web-calls-api
---
Notes are ignored by the compiler.
`
    );

    const loaded = await loadArchitectureWorkspace({
      workspaceRoot: fixture.workspaceRoot,
      repoRoot: fixture.root,
    });

    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.workspace.elements.map((element) => element.id)).toEqual(['api', 'web']);
    expect(loaded.workspace.manifest.elements.map((element) => element.id)).toEqual(['api', 'web']);
    expect(getWorkspaceSummary(loaded.workspace)).toMatchObject({
      name: 'SAM Fixture',
      counts: { elements: 2, relationships: 1, flows: 1, stateMachines: 1, views: 0 },
    });

    const details = showElement(loaded.workspace, 'api');
    expect(details?.incoming.map((relationship) => relationship.id)).toEqual(['web-calls-api']);
    expect(details?.stateMachines.map((machine) => machine.id)).toEqual(['session-state']);
    const detailsJson = JSON.stringify(details);
    expect(detailsJson).not.toContain('"position"');
    expect(detailsJson).not.toContain('"x"');
    expect(detailsJson).not.toContain('"y"');
  });

  it('returns actionable duplicate and dangling diagnostics', async () => {
    const fixture = await makeFixture();
    await writeFixtureFile(
      fixture.workspaceRoot,
      'model.yaml',
      `
version: 1
name: Broken
elements:
  - id: api
    kind: system
    title: API
  - id: api
    kind: system
    title: Duplicate API
relationships:
  - id: bad
    from: web
    to: api
`
    );

    const loaded = await loadArchitectureWorkspace({
      workspaceRoot: fixture.workspaceRoot,
      repoRoot: fixture.root,
    });

    expect(loaded.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'duplicate-id', message: expect.stringContaining('api') }),
        expect.objectContaining({
          code: 'dangling-reference',
          message: expect.stringContaining('web'),
        }),
      ])
    );
  });

  it('lists unresolved thread inbox with target metadata', async () => {
    const fixture = await makeFixture();
    await writeFixtureFile(
      fixture.workspaceRoot,
      'model.yaml',
      `
version: 1
name: Inbox
elements:
  - id: api
    kind: system
    title: API
`
    );
    await writeFixtureFile(
      fixture.workspaceRoot,
      'threads/thread-a.thread.md',
      `---
version: 1
id: thread-a
target: api
title: Clarify API
status: unresolved
createdAt: '2026-08-13T00:00:00.000Z'
updatedAt: '2026-08-13T00:00:00.000Z'
---
<!-- arch-message id: msg-a
author: agent
createdAt: '2026-08-13T00:00:00.000Z' -->
Question
`
    );

    const loaded = await loadArchitectureWorkspace({
      workspaceRoot: fixture.workspaceRoot,
      repoRoot: fixture.root,
    });

    expect(loaded.diagnostics).toEqual([]);
    expect(listUnresolvedInbox(loaded.workspace)).toHaveLength(1);
    expect(listUnresolvedInbox(loaded.workspace)[0]?.target?.id).toBe('api');
    expect(listUnresolvedInbox(loaded.workspace)[0]?.target?.kind).toBe('element');
    expect(path.isAbsolute(loaded.workspace.workspaceRoot)).toBe(true);
  });

  it('accepts threads on relationships, flows, and state machines', async () => {
    const fixture = await makeFixture();
    await writeFixtureFile(
      fixture.workspaceRoot,
      'model.yaml',
      `
version: 1
name: Review targets
elements:
  - id: api
    kind: system
    title: API
relationships:
  - id: api-self
    from: api
    to: api
    title: API loop
flows:
  - id: request
    title: Request
    steps:
      - id: call
        title: Call
        relationship: api-self
stateMachines:
  - id: lifecycle
    title: Lifecycle
    states:
      - id: ready
        title: Ready
`
    );
    for (const target of ['api-self', 'request', 'lifecycle']) {
      await writeFixtureFile(
        fixture.workspaceRoot,
        `threads/thread-${target}.thread.md`,
        `---
version: 1
id: thread-${target}
target: ${target}
title: Review ${target}
status: unresolved
createdAt: '2026-08-13T00:00:00.000Z'
updatedAt: '2026-08-13T00:00:00.000Z'
---
<!-- arch-message id: msg-${target}
author: agent
createdAt: '2026-08-13T00:00:00.000Z' -->
Question
`
      );
    }

    const loaded = await loadArchitectureWorkspace({
      workspaceRoot: fixture.workspaceRoot,
      repoRoot: fixture.root,
    });

    expect(loaded.diagnostics).toEqual([]);
    expect(listUnresolvedInbox(loaded.workspace).map((item) => item.target?.kind)).toEqual([
      'relationship',
      'stateMachine',
      'flow',
    ]);
  });
});
