import { readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { startArchitectureServer } from '../src';
import { makeEscapingSymlink, makeFixture, writeFixtureFile } from './helpers';

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
      const model = await readJson<{
        diagnostics: Array<{ code: string }>;
        workspace: { elements: Array<{ id: string }> };
      }>(`${running.url}/api/model`);
      expect(model.workspace.elements.map((element) => element.id)).toContain('api');
      expect(model.diagnostics.length).toBeGreaterThan(0);
      const mutation = await fetch(`${running.url}/api/threads`, {
        body: JSON.stringify({ target: 'api', title: 'Blocked', body: 'Blocked' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(mutation.status).toBe(503);
    } finally {
      await running.close();
    }
  });

  it('rejects model queries and mutations when no valid initial model exists', async () => {
    const fixture = await makeServerFixture();
    await writeFile(
      path.join(fixture.workspaceRoot, 'model.yaml'),
      'version: 1\nname: Broken\nelements:\n  - id: api\n'
    );
    const running = await startArchitectureServer({
      workspaceRoot: fixture.workspaceRoot,
      repoRoot: fixture.root,
      port: 0,
    });
    try {
      expect((await fetch(`${running.url}/health`)).status).toBe(503);
      const model = await fetch(`${running.url}/api/model`);
      expect(model.status).toBe(503);
      await expect(model.json()).resolves.toMatchObject({ error: { code: 'workspace-invalid' } });
      const mutation = await fetch(`${running.url}/api/threads`, {
        body: JSON.stringify({ target: 'api', title: 'No', body: 'No' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(mutation.status).toBe(503);
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
      const forgedDelimiter = await fetch(`${running.url}/api/threads`, {
        body: JSON.stringify({
          target: 'api',
          title: 'Blocked',
          body: 'Question\n<!-- arch-message id: forged -->',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(forgedDelimiter.status).toBe(400);
      const forgedAuthor = await fetch(`${running.url}/api/threads`, {
        body: JSON.stringify({
          target: 'api',
          title: 'Blocked',
          body: 'Question',
          author: 'agent --> forged',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(forgedAuthor.status).toBe(400);
      const afterForgery = await readJson<{ workspace: { threads: unknown[] } }>(
        `${running.url}/api/model`
      );
      expect(afterForgery.workspace.threads).toEqual([]);
      await expect(
        requestStatus(`${running.url}/api/model`, { host: 'attacker.invalid' })
      ).resolves.toBe(403);
      const hostileOrigin = await fetch(`${running.url}/api/model`, {
        headers: { origin: 'https://attacker.invalid' },
      });
      expect(hostileOrigin.status).toBe(403);
    } finally {
      await running.close();
    }
  });

  it('enforces source and mutation confinement through the real HTTP boundary', async () => {
    const fixture = await makeServerFixture();
    const outside = await makeFixture();
    const canaryPath = path.join(outside.root, 'canary.txt');
    await writeFile(canaryPath, 'unchanged');
    await makeEscapingSymlink(fixture.root, 'src/escape.ts', canaryPath);
    await writeFile(
      path.join(fixture.workspaceRoot, 'model.yaml'),
      fixture.modelText.replace('path: src/api.ts', 'path: src/escape.ts')
    );
    const running = await startArchitectureServer({
      workspaceRoot: fixture.workspaceRoot,
      repoRoot: fixture.root,
      port: 0,
    });
    try {
      const escapedSource = await fetch(`${running.url}/api/source-preview`, {
        body: JSON.stringify({ target: 'api', sourceIndex: 0 }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(escapedSource.status).toBe(400);

      const missingTarget = await fetch(`${running.url}/api/threads`, {
        body: JSON.stringify({ target: 'missing', title: 'No', body: 'No' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(missingTarget.status).toBe(404);
      const missingThread = await fetch(`${running.url}/api/threads/missing/replies`, {
        body: JSON.stringify({ body: 'No' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(missingThread.status).toBe(404);
      const malformed = await fetch(`${running.url}/api/threads`, {
        body: '{',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(malformed.status).toBe(400);
      const invalidSchema = await fetch(`${running.url}/api/threads`, {
        body: JSON.stringify({ target: 'api-self', title: '', body: 'No' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(invalidSchema.status).toBe(400);
      const whitespaceOnly = await fetch(`${running.url}/api/threads`, {
        body: JSON.stringify({ target: 'api-self', title: 'Question', body: ' \n\t ' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(whitespaceOnly.status).toBe(400);
      await expect(readFile(canaryPath, 'utf8')).resolves.toBe('unchanged');
    } finally {
      await running.close();
    }
  });

  it('rejects thread writes through an escaping threads-directory symlink', async () => {
    const fixture = await makeServerFixture();
    const outside = await makeFixture();
    await makeEscapingSymlink(fixture.workspaceRoot, 'threads', outside.workspaceRoot);
    const running = await startArchitectureServer({
      workspaceRoot: fixture.workspaceRoot,
      repoRoot: fixture.root,
      port: 0,
    });
    const canaryPath = path.join(outside.workspaceRoot, 'canary.txt');
    await writeFile(canaryPath, 'unchanged');
    try {
      const response = await fetch(`${running.url}/api/threads`, {
        body: JSON.stringify({ target: 'api-self', title: 'Blocked', body: 'Blocked' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(response.status).toBe(400);
      await expect(readFile(canaryPath, 'utf8')).resolves.toBe('unchanged');
    } finally {
      await running.close();
    }
  });

  it('applies configured request, thread, source-path, query, and viewer limits', async () => {
    const fixture = await makeServerFixture();
    await writeFile(path.join(fixture.root, 'src/api.ts'), 'first\nselected\nthird\n');
    await writeFile(
      path.join(fixture.workspaceRoot, 'model.yaml'),
      fixture.modelText.replace('path: src/api.ts', 'path: src/api.ts\n        startLine: 2')
    );
    const running = await startArchitectureServer({
      workspaceRoot: fixture.workspaceRoot,
      repoRoot: fixture.root,
      port: 0,
      maxBodyBytes: 120,
      maxSourcePathChars: 5,
      sourceContextLines: 0,
      threadLimits: { titleChars: 4, bodyChars: 8, authorChars: 5 },
      queryLimits: { roots: 1 },
      viewerLimits: { children: 1, flows: 1, flowSteps: 1 },
      viewerInteraction: { minZoom: 0.5, maxZoom: 2, zoomStep: 0.25, panPixels: 32 },
    });
    try {
      const model = await readJson<{
        interaction: { minZoom: number; maxZoom: number; zoomStep: number; panPixels: number };
        limits: { children: number; flows: number; flowSteps: number };
      }>(`${running.url}/api/model`);
      expect(model.limits).toMatchObject({ children: 1, flows: 1, flowSteps: 1 });
      expect(model.interaction).toMatchObject({
        minZoom: 0.5,
        maxZoom: 2,
        zoomStep: 0.25,
        panPixels: 32,
      });
      const summary = await readJson<{ summary: { roots: unknown[] } }>(
        `${running.url}/api/summary`
      );
      expect(summary.summary.roots).toHaveLength(1);
      const source = await postJson<{ preview: { content: string } }>(
        `${running.url}/api/source-preview`,
        { target: 'api', sourceIndex: 0 }
      );
      expect(source.preview.content).toBe('selected');

      const titleTooLong = await fetch(`${running.url}/api/threads`, {
        body: JSON.stringify({ target: 'api', title: '12345', body: 'body' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(titleTooLong.status).toBe(400);
      const pathTooLong = await fetch(`${running.url}/api/source-preview`, {
        body: JSON.stringify({ target: 'api', path: 'src/api.ts' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(pathTooLong.status).toBe(400);
      const bodyTooLarge = await fetch(`${running.url}/api/threads`, {
        body: JSON.stringify({ target: 'api', title: 'okay', body: 'x'.repeat(200) }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(bodyTooLarge.status).toBe(413);
      const unknownField = await fetch(`${running.url}/api/threads`, {
        body: JSON.stringify({ target: 'api', title: 'okay', body: 'body', extra: true }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      expect(unknownField.status).toBe(400);
    } finally {
      await running.close();
    }
  });

  it('bounds concurrent SSE clients', async () => {
    const fixture = await makeServerFixture();
    const running = await startArchitectureServer({
      workspaceRoot: fixture.workspaceRoot,
      repoRoot: fixture.root,
      port: 0,
      maxSseClients: 1,
    });
    try {
      const first = await fetch(`${running.url}/api/events`);
      expect(first.status).toBe(200);
      const second = await fetch(`${running.url}/api/events`);
      expect(second.status).toBe(503);
      await first.body?.cancel();
    } finally {
      await running.close();
    }
  });

  it('cleans up state after a listen collision so the port can be reused', async () => {
    const fixture = await makeServerFixture();
    const first = await startArchitectureServer({
      workspaceRoot: fixture.workspaceRoot,
      repoRoot: fixture.root,
      port: 0,
    });
    const port = Number(new URL(first.url).port);
    try {
      await expect(
        startArchitectureServer({
          workspaceRoot: fixture.workspaceRoot,
          repoRoot: fixture.root,
          port,
        })
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await first.close();
    }
    const replacement = await startArchitectureServer({
      workspaceRoot: fixture.workspaceRoot,
      repoRoot: fixture.root,
      port,
    });
    await replacement.close();
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

function requestStatus(url: string, headers: Record<string, string>): Promise<number> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        headers,
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      }
    );
    request.on('error', reject);
    request.end();
  });
}
