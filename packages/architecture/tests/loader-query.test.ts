import { access } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getWorkspaceSummary,
  listUnresolvedInbox,
  loadArchitectureWorkspace,
  mapChangedPathsToArchitecture,
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

  it('caps every list exposed by compact summary, show, and inbox queries', async () => {
    const fixture = await makeFixture();
    const sourceRefs = Array.from(
      { length: 4 },
      (_, index) => `      - path: src/source-${index}.ts`
    ).join('\n');
    const children = Array.from(
      { length: 4 },
      (_, index) =>
        `  - id: child-${index}\n    parent: root\n    kind: component\n    title: Child ${index}`
    ).join('\n');
    const steps = Array.from(
      { length: 4 },
      (_, index) => `      - id: step-${index}\n        title: Step ${index}\n        element: root`
    ).join('\n');
    const states = Array.from(
      { length: 4 },
      (_, index) => `      - id: state-${index}\n        title: State ${index}`
    ).join('\n');
    const transitions = Array.from(
      { length: 3 },
      (_, index) =>
        `      - from: state-${index}\n        to: state-${index + 1}\n        event: next-${index}`
    ).join('\n');
    await writeFixtureFile(
      fixture.workspaceRoot,
      'model.yaml',
      `version: 1
name: Bounded
elements:
  - id: root
    kind: system
    title: Root
    metadata:
      arbitrary: omitted
    sourceRefs:
${sourceRefs}
${children}
  - id: other-root-a
    kind: system
    title: Other A
  - id: other-root-b
    kind: system
    title: Other B
flows:
  - id: flow-a
    title: Flow A
    steps:
${steps}
  - id: flow-b
    title: Flow B
    steps:
      - id: only
        title: Only
        element: root
stateMachines:
  - id: machine-a
    title: Machine A
    element: root
    states:
${states}
    transitions:
${transitions}
  - id: machine-b
    title: Machine B
    element: root
    states:
      - id: ready
        title: Ready
`
    );
    for (const suffix of ['a', 'b']) {
      await writeFixtureFile(
        fixture.workspaceRoot,
        `threads/thread-${suffix}.thread.md`,
        `---
version: 1
id: thread-${suffix}
target: root
title: Thread ${suffix}
status: unresolved
createdAt: '2026-08-13T00:00:00.000Z'
updatedAt: '2026-08-13T00:00:00.000Z'
---
<!-- arch-message id: msg-${suffix}-1
author: agent
createdAt: '2026-08-13T00:00:00.000Z' -->
First
<!-- arch-message id: msg-${suffix}-2
author: agent
createdAt: '2026-08-13T00:01:00.000Z' -->
Second
`
      );
    }
    const loaded = await loadArchitectureWorkspace({
      workspaceRoot: fixture.workspaceRoot,
      repoRoot: fixture.root,
    });
    expect(loaded.diagnostics).toEqual([]);
    const limits = {
      roots: 2,
      children: 2,
      memberships: 1,
      sourceRefs: 1,
      flowSteps: 1,
      states: 1,
      transitions: 1,
      threads: 1,
      threadMessages: 1,
    };
    const summary = getWorkspaceSummary(loaded.workspace, limits);
    const details = showElement(loaded.workspace, 'root', limits);
    const inbox = listUnresolvedInbox(loaded.workspace, 1, limits);

    expect(summary.roots).toHaveLength(2);
    expect(summary.truncated.roots).toBe(1);
    expect(details).toMatchObject({
      truncated: { children: 2, flows: 1, stateMachines: 1, threads: 1, sourceRefs: 3 },
    });
    expect(details?.element).not.toHaveProperty('metadata');
    expect(details?.flows[0]?.steps).toHaveLength(1);
    expect(details?.flows[0]?.truncated.steps).toBe(3);
    expect(details?.stateMachines[0]?.states).toHaveLength(1);
    expect(details?.stateMachines[0]?.transitions).toHaveLength(1);
    expect(details?.unresolvedThreads[0]?.messages).toHaveLength(1);
    expect(inbox[0]?.thread.messages).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(details), 'utf8')).toBeLessThan(5_000);
    expect(showElement(loaded.workspace, 'root', { children: -1 })?.children).toEqual([]);
  });

  it('produces the same canonical graph regardless of document creation order', async () => {
    const first = await makeFixture();
    const second = await makeFixture();
    const documents = {
      'z.yaml': `version: 1\nname: Ordered\nelements:\n  - id: z\n    kind: system\n    title: Z\n`,
      'a.yaml': `elements:\n  - id: a\n    kind: system\n    title: A\n`,
    };
    for (const [name, content] of Object.entries(documents)) {
      await writeFixtureFile(first.workspaceRoot, name, content);
    }
    for (const [name, content] of Object.entries(documents).reverse()) {
      await writeFixtureFile(second.workspaceRoot, name, content);
    }
    const left = await loadArchitectureWorkspace({
      workspaceRoot: first.workspaceRoot,
      repoRoot: first.root,
    });
    const right = await loadArchitectureWorkspace({
      workspaceRoot: second.workspaceRoot,
      repoRoot: second.root,
    });
    expect(left.diagnostics).toEqual([]);
    expect(right.diagnostics).toEqual([]);
    expect(left.workspace.elements).toEqual(right.workspace.elements);
    expect(left.workspace.manifest).toEqual(right.workspace.manifest);
  });

  it('reports malformed documents, duplicate manifests, and dangling nested references', async () => {
    const fixture = await makeFixture();
    await writeFixtureFile(fixture.workspaceRoot, 'broken.yaml', 'elements: [\n');
    await writeFixtureFile(
      fixture.workspaceRoot,
      'wrong-version.yaml',
      'version: 2\nname: Wrong\n'
    );
    await writeFixtureFile(fixture.workspaceRoot, 'manifest-a.yaml', 'version: 1\nname: First\n');
    await writeFixtureFile(fixture.workspaceRoot, 'manifest-b.yaml', 'version: 1\nname: Second\n');
    await writeFixtureFile(
      fixture.workspaceRoot,
      'references.yaml',
      `elements:
  - id: api
    kind: system
    title: API
flows:
  - id: bad-flow
    title: Bad flow
    steps:
      - id: missing
        title: Missing
        element: absent
stateMachines:
  - id: bad-machine
    title: Bad machine
    states:
      - id: ready
        title: Ready
    transitions:
      - from: missing
        to: ready
views:
  - id: bad-view
    title: Bad view
    flows: [absent-flow]
`
    );
    await writeFixtureFile(
      fixture.workspaceRoot,
      'threads/dangling.thread.md',
      `---
version: 1
id: dangling
target: absent
title: Dangling
createdAt: '2026-08-13T00:00:00.000Z'
updatedAt: '2026-08-13T00:00:00.000Z'
---
`
    );
    const loaded = await loadArchitectureWorkspace({
      workspaceRoot: fixture.workspaceRoot,
      repoRoot: fixture.root,
    });
    expect(loaded.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'parse-error',
        'schema-invalid',
        'duplicate-manifest',
        'dangling-reference',
      ])
    );
    expect(loaded.diagnostics.map((item) => item.message).join('\n')).toMatch(
      /absent|missing|absent-flow/
    );
  });

  it('loads the checked-in SAM dogfood model with source-backed cross-runtime examples', async () => {
    const repoRoot = path.resolve(process.cwd(), '../..');
    const loaded = await loadArchitectureWorkspace({
      workspaceRoot: path.join(repoRoot, 'architecture'),
      repoRoot,
    });
    expect(loaded.diagnostics).toEqual([]);
    expect(
      loaded.workspace.elements.filter((item) => item.kind === 'runtime').length
    ).toBeGreaterThan(1);
    expect(loaded.workspace.flows.length).toBeGreaterThanOrEqual(2);
    expect(loaded.workspace.stateMachines.length).toBeGreaterThanOrEqual(1);
    expect(loaded.workspace.indexes.flowsById.has('cli-browser-login')).toBe(true);
    expect(loaded.workspace.indexes.flowsById.has('delegated-task-startup-vm')).toBe(true);
    expect(loaded.workspace.indexes.flowsById.has('delegated-task-startup-instant')).toBe(true);
    const sourceRefs = [
      ...loaded.workspace.elements.flatMap((item) => item.sourceRefs ?? []),
      ...loaded.workspace.relationships.flatMap((item) => item.sourceRefs ?? []),
      ...loaded.workspace.flows.flatMap((item) => [
        ...(item.sourceRefs ?? []),
        ...item.steps.flatMap((step) => step.sourceRefs ?? []),
      ]),
      ...loaded.workspace.stateMachines.flatMap((item) => [
        ...(item.sourceRefs ?? []),
        ...item.states.flatMap((state) => state.sourceRefs ?? []),
        ...item.transitions.flatMap((transition) => transition.sourceRefs ?? []),
      ]),
    ];
    await Promise.all(sourceRefs.map((ref) => access(path.join(repoRoot, ref.path))));
    const taskRunnerImpact = await mapChangedPathsToArchitecture(loaded.workspace, [
      'apps/api/src/durable-objects/task-runner/node-steps.ts',
    ]);
    expect(taskRunnerImpact.impacted).toContainEqual(
      expect.objectContaining({ kind: 'stateMachine', id: 'task-runner-lifecycle' })
    );
  });
});
