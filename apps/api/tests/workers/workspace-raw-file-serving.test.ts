/**
 * Workspace files opened through the API's raw file proxy, through the real
 * worker: session cookie → auth middleware → workspace lookup → VM agent fetch.
 * Only the VM agent is simulated. It answers the way the real one does, with the
 * Content-Type derived from the file's extension, so an agent-written `.html`
 * arrives as `text/html`.
 */
import { SELF } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  seedInstallation,
  seedNode,
  seedProject,
  seedSignedInUser,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';

const API = 'https://api.test.example.com';
const INERT_DOCUMENT_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

const suffix = crypto.randomUUID();
const userId = `raw-file-user-${suffix}`;
const projectId = `raw-file-project-${suffix}`;
const nodeId = `raw-file-node-${suffix}`;
const workspaceId = `raw-file-workspace-${suffix}`;
const sessionId = `raw-file-session-${suffix}`;
let sessionCookie = '';

beforeAll(async () => {
  const installationId = `raw-file-install-${suffix}`;
  await seedUser(userId);
  await seedInstallation(installationId, userId);
  await seedProject(projectId, userId, installationId);
  await seedNode(nodeId, userId);
  await seedWorkspace(workspaceId, nodeId, userId, {
    projectId,
    status: 'running',
    chatSessionId: sessionId,
  });
  sessionCookie = await seedSignedInUser(userId);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Answer every VM agent request as its raw file handler would. */
function stubVmAgent(contentType: string, body: string, headers: Record<string, string> = {}) {
  const vmAgent = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.hostname.endsWith('.vm.test.example.com')) return new Response(null, { status: 404 });
    return new Response(body, { headers: { 'Content-Type': contentType, ...headers } });
  });
  vi.stubGlobal('fetch', vmAgent);
  return vmAgent;
}

function openRawFile(path: string) {
  const query = new URLSearchParams({ path });
  return SELF.fetch(
    `${API}/api/projects/${projectId}/sessions/${sessionId}/files/raw?${query.toString()}`,
    { headers: { Cookie: sessionCookie } }
  );
}

describe('GET /api/projects/:id/sessions/:sessionId/files/raw', () => {
  it('downloads agent-written HTML instead of rendering it, and keeps it inert', async () => {
    const html = '<html><body><script>fetch("/api/auth/api-tokens")</script></body></html>';
    const vmAgent = stubVmAgent('text/html; charset=utf-8', html, {
      // The proxy's policy is its own: a looser one from the VM agent is not kept.
      'Content-Security-Policy': "script-src 'unsafe-inline'",
    });

    const response = await openRawFile('/workspaces/repo/report.html');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="report.html"');
    expect(response.headers.get('Content-Security-Policy')).toBe(INERT_DOCUMENT_CSP);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await response.text()).toBe(html);
    const [request] = vmAgent.mock.calls.map(([input]) => new URL(String(input)));
    expect(request?.pathname).toBe(`/workspaces/${workspaceId}/files/raw`);
    expect(request?.searchParams.get('path')).toBe('/workspaces/repo/report.html');
  });

  // An <img> ignores Content-Disposition, so an SVG still draws in the app.
  it.each([
    ['an SVG', 'diagram.svg', 'image/svg+xml', 'attachment; filename="diagram.svg"'],
    ['a PNG', 'screenshot.png', 'image/png', null],
  ])('keeps %s embeddable as an image', async (_kind, name, contentType, disposition) => {
    stubVmAgent(contentType, 'image bytes');

    const response = await openRawFile(`/workspaces/repo/${name}`);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe(contentType);
    expect(response.headers.get('Content-Disposition')).toBe(disposition);
    expect(response.headers.get('Content-Security-Policy')).toBe(INERT_DOCUMENT_CSP);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('image bytes');
  });
});
