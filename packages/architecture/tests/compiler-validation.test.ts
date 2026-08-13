import { describe, expect, it } from 'vitest';

import { loadArchitectureWorkspace } from '../src';
import { makeFixture, writeFixtureFile } from './helpers';

describe('architecture compiler identity and schema validation', () => {
  it('requires a versioned manifest instead of silently synthesizing one', async () => {
    const fixture = await makeFixture();
    await writeFixtureFile(
      fixture.workspaceRoot,
      'records.yaml',
      'elements:\n  - id: api\n    kind: system\n    title: API\n'
    );
    const loaded = await loadArchitectureWorkspace({
      workspaceRoot: fixture.workspaceRoot,
      repoRoot: fixture.root,
    });
    expect(loaded.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'manifest-missing', severity: 'error' })
    );
  });

  it('rejects unknown fields and unsafe source paths', async () => {
    const fixture = await makeFixture();
    await writeFixtureFile(fixture.workspaceRoot, 'manifest.yaml', 'version: 1\nname: Strict\n');
    await writeFixtureFile(
      fixture.workspaceRoot,
      'unknown.yaml',
      'elements:\n  - id: api\n    kind: system\n    title: API\n    surprise: true\n'
    );
    await writeFixtureFile(
      fixture.workspaceRoot,
      'unsafe.yaml',
      'elements:\n  - id: web\n    kind: system\n    title: Web\n    sourceRefs:\n      - path: ../secret\n'
    );
    const loaded = await loadArchitectureWorkspace({
      workspaceRoot: fixture.workspaceRoot,
      repoRoot: fixture.root,
    });
    expect(loaded.diagnostics.filter((item) => item.code === 'schema-invalid')).toHaveLength(2);
    expect(loaded.diagnostics.map((item) => item.message).join('\n')).toMatch(
      /unknown|safe repository-relative paths/i
    );
  });

  it('diagnoses nested duplicate IDs, parent cycles, and reversed source ranges', async () => {
    const fixture = await makeFixture();
    await writeFixtureFile(
      fixture.workspaceRoot,
      'model.yaml',
      `version: 1
name: Identity checks
elements:
  - id: a
    parent: b
    kind: component
    title: A
    sourceRefs:
      - path: src/a.ts
        startLine: 9
        endLine: 2
  - id: b
    parent: a
    kind: component
    title: B
flows:
  - id: flow
    title: Flow
    steps:
      - id: repeat
        title: First
        element: a
      - id: repeat
        title: Second
        element: b
stateMachines:
  - id: machine
    title: Machine
    states:
      - id: repeat
        title: First
      - id: repeat
        title: Second
`
    );
    const loaded = await loadArchitectureWorkspace({
      workspaceRoot: fixture.workspaceRoot,
      repoRoot: fixture.root,
    });
    const codes = loaded.diagnostics.map((item) => item.code);
    expect(codes.filter((code) => code === 'duplicate-id')).toHaveLength(2);
    expect(codes).toContain('parent-cycle');
    expect(codes).toContain('source-range-invalid');
  });
});
