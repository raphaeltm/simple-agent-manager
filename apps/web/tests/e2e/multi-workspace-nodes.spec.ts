import { test, expect } from '@playwright/test';

test.describe('multi-workspace nodes', () => {
  test('node -> workspace -> session happy path', async ({ page }) => {
    const state = {
      nodes: [
        {
          id: 'node-1',
          name: 'Node 1',
          status: 'running',
          healthStatus: 'healthy',
          vmSize: 'medium',
          vmLocation: 'nbg1',
          ipAddress: '1.1.1.1',
          lastHeartbeatAt: '2026-02-12T00:00:00.000Z',
          heartbeatStaleAfterSeconds: 180,
          errorMessage: null,
          createdAt: '2026-02-12T00:00:00.000Z',
          updatedAt: '2026-02-12T00:00:00.000Z',
        },
      ],
      workspaces: [
        {
          id: 'ws-1',
          nodeId: 'node-1',
          name: 'Workspace 1',
          displayName: 'Workspace 1',
          repository: 'octo/repo',
          branch: 'main',
          status: 'running',
          vmSize: 'medium',
          vmLocation: 'nbg1',
          vmIp: null,
          lastActivityAt: null,
          errorMessage: null,
          createdAt: '2026-02-12T00:00:00.000Z',
          updatedAt: '2026-02-12T00:00:00.000Z',
          url: 'https://ws-ws-1.example.test',
        },
      ],
      sessions: [] as Array<{
        id: string;
        workspaceId: string;
        status: string;
        createdAt: string;
        updatedAt: string;
      }>,
    };

    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method();

      if (path.startsWith('/api/auth/')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ user: { id: 'u-1', email: 'demo@example.com', name: 'Demo User' } }),
        });
      }

      if (path === '/api/nodes' && method === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.nodes) });
      }
      if (path === '/api/nodes/node-1' && method === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.nodes[0]) });
      }
      if (path === '/api/nodes/node-1/events' && method === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ events: [], nextCursor: null }) });
      }

      if (path === '/api/workspaces' && method === 'GET') {
        const nodeId = url.searchParams.get('nodeId');
        const filtered = nodeId ? state.workspaces.filter((workspace) => workspace.nodeId === nodeId) : state.workspaces;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(filtered) });
      }
      if (path === '/api/workspaces/ws-1' && method === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.workspaces[0]) });
      }
      if (path === '/api/workspaces/ws-1/events' && method === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ events: [], nextCursor: null }) });
      }
      if (path === '/api/workspaces/ws-1/agent-sessions' && method === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.sessions) });
      }
      if (path === '/api/workspaces/ws-1/agent-sessions' && method === 'POST') {
        const created = {
          id: `sess-${state.sessions.length + 1}`,
          workspaceId: 'ws-1',
          status: 'running',
          createdAt: '2026-02-12T00:05:00.000Z',
          updatedAt: '2026-02-12T00:05:00.000Z',
        };
        state.sessions.unshift(created);
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(created) });
      }
      if (path === '/api/terminal/token' && method === 'POST') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            token: 'tok_1',
            expiresAt: '2026-02-12T01:00:00.000Z',
            workspaceUrl: 'https://ws-ws-1.example.test',
          }),
        });
      }

      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
    });

    await page.goto('/');
    await expect(page).toHaveTitle(/Simple Agent Manager|SAM/i);

    await page.goto('/nodes');
    await expect(page.getByRole('button', { name: /create node/i })).toBeVisible();

    await page.goto('/workspaces/ws-1');
    await expect(page.getByText('Agent Sessions')).toBeVisible();
    await page.getByRole('button', { name: /new session/i }).click();
    await expect(page.getByText(/sess-1/i)).toBeVisible();
  });

  test('workspace session failure surface is user-visible', async ({ page }) => {
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method();

      if (path.startsWith('/api/auth/')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ user: { id: 'u-1', email: 'demo@example.com', name: 'Demo User' } }),
        });
      }
      if (path === '/api/workspaces/ws-1' && method === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'ws-1',
            nodeId: 'node-1',
            name: 'Workspace 1',
            displayName: 'Workspace 1',
            repository: 'octo/repo',
            branch: 'main',
            status: 'running',
            vmSize: 'medium',
            vmLocation: 'nbg1',
            vmIp: null,
            lastActivityAt: null,
            errorMessage: null,
            createdAt: '2026-02-12T00:00:00.000Z',
            updatedAt: '2026-02-12T00:00:00.000Z',
            url: 'https://ws-ws-1.example.test',
          }),
        });
      }
      if (path === '/api/workspaces/ws-1/events' && method === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ events: [], nextCursor: null }) });
      }
      if (path === '/api/workspaces/ws-1/agent-sessions' && method === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
      }
      if (path === '/api/workspaces/ws-1/agent-sessions' && method === 'POST') {
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'workspace_not_running', message: 'Cannot create agent session right now' }),
        });
      }
      if (path === '/api/terminal/token' && method === 'POST') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            token: 'tok_1',
            expiresAt: '2026-02-12T01:00:00.000Z',
            workspaceUrl: 'https://ws-ws-1.example.test',
          }),
        });
      }

      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
    });

    await page.goto('/workspaces/ws-1');
    await page.getByRole('button', { name: /new session/i }).click();
    await expect(page.getByText(/cannot create agent session right now/i)).toBeVisible();
  });
});
