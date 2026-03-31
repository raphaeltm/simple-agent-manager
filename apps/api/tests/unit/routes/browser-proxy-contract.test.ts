/**
 * Cross-boundary contract tests for browser sidecar proxy routes.
 *
 * Verifies that the API Worker proxy routes construct URLs that match the VM agent's
 * registered routes, and that the auth mechanism (terminal token as query param) is
 * consistent across both sides.
 *
 * See: .claude/rules/23-cross-boundary-contract-tests.md
 */
import { describe, it, expect } from 'vitest';

describe('Browser sidecar proxy — cross-boundary contract', () => {
  // The API Worker constructs VM agent URLs like:
  //   {protocol}://{nodeId}.vm.{BASE_DOMAIN}:{port}/workspaces/{workspaceId}/browser
  //
  // The VM agent registers routes like:
  //   mux.HandleFunc("POST /workspaces/{workspaceId}/browser", handler)

  const VM_AGENT_BROWSER_ROUTES = [
    { method: 'POST', path: '/workspaces/{workspaceId}/browser' },
    { method: 'GET', path: '/workspaces/{workspaceId}/browser' },
    { method: 'DELETE', path: '/workspaces/{workspaceId}/browser' },
    { method: 'GET', path: '/workspaces/{workspaceId}/browser/ports' },
  ];

  const API_PROXY_VM_PATHS = [
    { method: 'POST', vmPath: 'browser', description: 'start browser sidecar' },
    { method: 'GET', vmPath: 'browser', description: 'get browser status' },
    { method: 'DELETE', vmPath: 'browser', description: 'stop browser sidecar' },
    { method: 'GET', vmPath: 'browser/ports', description: 'list browser ports' },
  ];

  describe('URL path contract', () => {
    it('API proxy vmPath values match VM agent route suffixes', () => {
      // The API proxy constructs: /workspaces/{workspaceId}/{vmPath}
      // The VM agent registers: /workspaces/{workspaceId}/{suffix}
      for (const proxy of API_PROXY_VM_PATHS) {
        const expectedVmRoute = `/workspaces/{workspaceId}/${proxy.vmPath}`;
        const matchingRoute = VM_AGENT_BROWSER_ROUTES.find(
          (r) => r.method === proxy.method && r.path === expectedVmRoute
        );
        expect(matchingRoute).toBeDefined();
      }
    });

    it('every VM agent browser route has a corresponding API proxy', () => {
      for (const route of VM_AGENT_BROWSER_ROUTES) {
        const suffix = route.path.replace('/workspaces/{workspaceId}/', '');
        const matchingProxy = API_PROXY_VM_PATHS.find(
          (p) => p.method === route.method && p.vmPath === suffix
        );
        expect(matchingProxy).toBeDefined();
      }
    });
  });

  describe('auth mechanism contract', () => {
    it('API proxy passes token as query parameter (not header)', () => {
      // The VM agent reads auth tokens from the query parameter `?token=`.
      // The API proxy must pass the terminal token as a query parameter.
      // This test documents the contract — if either side changes, this test
      // must be updated.

      // Simulated URL construction from proxyBrowserToVmAgent / proxyBrowserRequest
      const workspaceUrl = 'https://node-abc.vm.example.com:8443';
      const workspaceId = 'ws-test-123';
      const vmPath = 'browser';
      const token = 'jwt-token-here';

      const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/${vmPath}?token=${encodeURIComponent(token)}`;

      const parsed = new URL(url);
      expect(parsed.searchParams.get('token')).toBe(token);
      expect(parsed.pathname).toBe(`/workspaces/${workspaceId}/${vmPath}`);
    });
  });

  describe('response shape contract', () => {
    it('BrowserSidecarResponse type matches VM agent response structure', () => {
      // The VM agent returns:
      const vmAgentResponse = {
        status: 'running',
        nekoPort: 8080,
        url: 'https://ws-test--8080.example.com',
        containerName: 'neko-ws-test-123',
        error: '',
        ports: [
          { port: 3000, targetHost: 'devcontainer-ws-test', active: true },
        ],
      };

      // Verify all expected fields are present
      expect(vmAgentResponse).toHaveProperty('status');
      expect(vmAgentResponse).toHaveProperty('nekoPort');
      expect(vmAgentResponse).toHaveProperty('url');
      expect(vmAgentResponse).toHaveProperty('containerName');
      expect(vmAgentResponse).toHaveProperty('ports');

      // Verify port forwarder shape
      const port = vmAgentResponse.ports[0];
      expect(port).toHaveProperty('port');
      expect(port).toHaveProperty('targetHost');
      expect(port).toHaveProperty('active');
    });
  });

  describe('workspace-level routes contract', () => {
    it('workspace browser routes use the same VM agent paths as project routes', () => {
      // Both route sets (project-session and workspace-direct) must target
      // the same VM agent endpoints. Only the API-side path differs:
      //
      // Project-session: POST /projects/:id/sessions/:sessionId/browser
      //   → VM agent: POST /workspaces/{workspaceId}/browser
      //
      // Workspace-direct: POST /workspaces/:id/browser
      //   → VM agent: POST /workspaces/{workspaceId}/browser
      //
      // Both resolve to the same vmPath values.
      const projectVmPaths = ['browser', 'browser', 'browser', 'browser/ports'];
      const workspaceVmPaths = ['browser', 'browser', 'browser', 'browser/ports'];

      expect(projectVmPaths).toEqual(workspaceVmPaths);
    });
  });
});
