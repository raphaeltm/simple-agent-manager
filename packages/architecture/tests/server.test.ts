import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { startArchitectureServer } from '../src';
import { makeFixture, writeFixtureFile } from './helpers';

describe('architecture local HTTP server', () => {
  it('serves model/source/thread routes and reloads direct file edits over SSE', async () => {
    const fixture = await makeServerFixture();
    const running = await startArchitectureServer({
      workspaceRoot: fixture.workspaceRoot,
      repoRoot: fixture.root,
      port: 0,
      watchIntervalMs: 50,
    });
    try {
      const events = eventReader(`${running.url}/api/events`);
      await expect(readJson(`${running.url}/health`)).resolves.toMatchObject({ ok: true });
      const model = await readJson<{ workspace: { elements: Array<{ id: string }> } }>(
        `${running.url}/api/model`
      );
      expect(model.workspace.elements.map((element) => element.id)).toContain('api');

      const source = await postJson<{ preview: { content: string } }>(
        `${running.url}/api/source-preview`,
        {
          target: 'api',
          path: 'src/api.ts',
        }
      );
      expect(source.preview.content).toContain('hello');

      const thread = await postJson<{ artifactPath: string; thread: { id: string } }>(
        `${running.url}/api/threads`,
        {
          target: 'api-self',
          title: 'Clarify <script>alert(1)</script>',
          body: 'Question with emoji 🚀',
        }
      );
      expect(thread.artifactPath).toMatch(/architecture\/threads\/thread-/);

      const reply = await postJson<{ artifactPath: string }>(
        `${running.url}/api/threads/${thread.thread.id}/replies`,
        { body: 'Reply' }
      );
      expect(reply.artifactPath).toBe(thread.artifactPath);

      await writeFile(
        path.join(fixture.workspaceRoot, 'model.yaml'),
        fixture.modelText.replace('title: API', 'title: API updated')
      );
      const eventText = await events;
      expect(eventText).toContain('architecture:model');
      expect(eventText.match(/^event:/gm)).toHaveLength(eventText.match(/^data:/gm)?.length ?? 0);
      await expect(pollModelTitle(running.url)).resolves.toBe('API updated');
    } finally {
      await running.close();
    }
  });

  it('reports invalid edits while continuing to serve the last valid model', async () => {
    const fixture = await makeServerFixture();
    const running = await startArchitectureServer({
      workspaceRoot: fixture.workspaceRoot,
      repoRoot: fixture.root,
      port: 0,
      watchIntervalMs: 50,
    });
    try {
      await writeFile(
        path.join(fixture.workspaceRoot, 'model.yaml'),
        'version: 1\nname: Broken\nelements:\n  - id: api\n'
      );
      await expect(pollHealth(running.url, false)).resolves.toBe(false);
      const model = await readJson<{ workspace: { elements: Array<{ id: string }> } }>(
        `${running.url}/api/model`
      );
      expect(model.workspace.elements.map((element) => element.id)).toContain('api');
    } finally {
      await running.close();
    }
  });

  it('rejects unsafe binds, unsupported JSON boundaries, and invalid source targets', async () => {
    const fixture = await makeServerFixture();
    await expect(
      startArchitectureServer({
        workspaceRoot: fixture.workspaceRoot,
        repoRoot: fixture.root,
        host: '0.0.0.0',
        port: 0,
      })
    ).rejects.toThrow('Refusing non-loopback');
    const running = await startArchitectureServer({
      workspaceRoot: fixture.workspaceRoot,
      repoRoot: fixture.root,
      port: 0,
    });
    try {
      await expect(
        postJson(`${running.url}/api/source-preview`, { target: 'api', path: '/tmp/secret' })
      ).rejects.toThrow('anchored');
      const wrongType = await fetch(`${running.url}/api/threads`, {
        body: '{}',
        headers: { 'content-type': 'text/plain' },
        method: 'POST',
      });
      expect(wrongType.status).toBe(415);
      const oversized = await fetch(`${running.url}/api/threads`, {
        body: JSON.stringify({ target: 'api', title: 'x', body: 'x'.repeat(40_000) }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(oversized.status).toBe(413);
      const unsupported = await fetch(`${running.url}/api/model`, { method: 'POST' });
      expect(unsupported.status).toBe(405);
    } finally {
      await running.close();
    }
  });
});

async function makeServerFixture() {
  const fixture = await makeFixture();
  await writeFixtureFile(fixture.root, 'src/api.ts', 'export const hello = "world";\n');
  const modelText = `
version: 1
name: Server Fixture
elements:
  - id: root
    kind: system
    title: Root
  - id: api
    parent: root
    kind: component
    title: API
    sourceRefs:
      - path: src/api.ts
relationships:
  - id: api-self
    from: api
    to: api
flows:
  - id: request-flow
    title: Request flow
    steps:
      - id: call
        title: Call API
        element: api
stateMachines:
  - id: task-state
    title: Task state
    states:
      - id: queued
        title: Queued
      - id: running
        title: Running
    transitions:
      - from: queued
        to: running
        event: start
`;
  await writeFixtureFile(fixture.workspaceRoot, 'model.yaml', modelText);
  return { ...fixture, modelText };
}

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  return (await response.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  if (!response.ok) {
    const payload = (await response.json()) as { error?: { message?: string } };
    throw new Error(payload.error?.message ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

async function eventReader(url: string): Promise<string> {
  const response = await fetch(url);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing SSE body reader.');
  const decoder = new TextDecoder();
  let text = '';
  for (let index = 0; index < 20; index += 1) {
    const next = await reader.read();
    text += decoder.decode(next.value);
    if (text.includes('architecture:model')) {
      await reader.cancel();
      return text;
    }
  }
  throw new Error(`No model event received. Saw: ${text}`);
}

async function pollModelTitle(url: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const model = await readJson<{ workspace: { elements: Array<{ id: string; title: string }> } }>(
      `${url}/api/model`
    );
    const title = model.workspace.elements.find((element) => element.id === 'api')?.title;
    if (title === 'API updated') return title;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Model did not reload.');
}

async function pollHealth(url: string, expected: boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${url}/health`);
    const health = (await response.json()) as { ok: boolean };
    if (health.ok === expected) return health.ok;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Health did not become ${expected}.`);
}
