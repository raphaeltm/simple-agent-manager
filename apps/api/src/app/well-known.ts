import type { ApiApp } from './types';

export function registerWellKnownRoutes(app: ApiApp): void {
  // JWKS endpoint (must be at root level).
  app.get('/.well-known/jwks.json', async (c) => {
    const { getJWKS } = await import('../services/jwt');
    const jwks = await getJWKS(c.env);
    c.header('Cache-Control', 'public, max-age=3600');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.json(jwks);
  });

  // OIDC Discovery endpoint — used by GCP Workload Identity Federation to verify SAM as an IdP.
  app.get('/.well-known/openid-configuration', async (c) => {
    const { getOidcDiscovery } = await import('../services/jwt');
    const discovery = getOidcDiscovery(c.env);
    c.header('Cache-Control', 'public, max-age=3600');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.json(discovery);
  });
}
