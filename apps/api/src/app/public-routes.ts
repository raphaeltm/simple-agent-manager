import type { ApiApp } from './types';

export function registerPublicRoutes(app: ApiApp): void {
  // Health check — public endpoint returns minimal info only.
  app.get('/health', (c) => {
    const hasCriticalBindings = !!(
      c.env.DATABASE &&
      c.env.KV &&
      c.env.PROJECT_DATA &&
      c.env.NODE_LIFECYCLE &&
      c.env.TASK_RUNNER
    );

    return c.json({
      status: hasCriticalBindings ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
    }, hasCriticalBindings ? 200 : 503);
  });

  // Public config — exposes feature flags the UI needs before auth.
  app.get('/api/config/artifacts-enabled', (c) => {
    return c.json({ enabled: c.env.ARTIFACTS_ENABLED === 'true' && !!c.env.ARTIFACTS });
  });
}
