import { describe, expect, it } from 'vitest';
import { verifyEngineReadiness } from './installer-engine-readiness.js';

const commit = 'a'.repeat(40);
function scenario(stale: 'worker' | 'pages' | 'asset' | undefined = undefined) {
  return {
    apiBase: 'https://api.cloudflare.com/client/v4',
    accountId: 'account',
    token: 'private',
    worker: 'api',
    pages: 'web',
    domain: 'example.com',
    commit,
    async request(url: string) {
      if (url.endsWith('/deployments'))
        return Response.json({
          success: true,
          result: { deployments: [{ versions: [{ version_id: 'one', percentage: 100 }] }] },
        });
      if (url.endsWith('/versions/one'))
        return Response.json({
          success: true,
          result: { annotations: { 'workers/tag': stale === 'worker' ? 'old' : commit } },
        });
      if (url.endsWith('/projects/web'))
        return Response.json({
          success: true,
          result: {
            canonical_deployment: {
              deployment_trigger: { metadata: { commit_hash: stale === 'pages' ? 'old' : commit } },
              latest_stage: { name: 'deploy', status: 'success' },
            },
          },
        });
      if (url.endsWith('/api/setup/status'))
        return Response.json({ open: true, tokenConfigured: true });
      if (url.endsWith('/health')) return Response.json({ status: 'healthy' });
      if (url.endsWith('/app.js'))
        return new Response('application', {
          status: stale === 'asset' ? 404 : 200,
          headers: { 'content-type': 'application/javascript' },
        });
      return new Response('<div id="root"></div><script src="/app.js"></script>', {
        headers: { 'content-type': 'text/html' },
      });
    },
  };
}
describe('deployment readiness', () => {
  it('requires active API and Pages source identities and routed app/setup assets', async () => {
    await expect(verifyEngineReadiness(scenario())).resolves.toBeUndefined();
  });
  it.each(['worker', 'pages', 'asset'] as const)(
    'rejects %s failure even with healthy API',
    async (failure) => {
      await expect(verifyEngineReadiness(scenario(failure))).rejects.toThrow();
    }
  );
});
