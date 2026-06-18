import { cors } from 'hono/cors';

import { log } from '../lib/logger';
import { analyticsMiddleware } from '../middleware/analytics';
import type { ApiApp } from './types';

export function registerGlobalMiddleware(app: ApiApp): void {
  registerStructuredRequestLogging(app);

  // Analytics Engine — writes one data point per request (non-blocking, fire-and-forget).
  app.use('*', analyticsMiddleware());

  app.use('*', cors({
    origin: (origin, c) => {
      if (!origin) return null;
      const baseDomain = c.env?.BASE_DOMAIN || '';
      // Allow localhost only in development (BASE_DOMAIN contains 'localhost' or is empty).
      const isDevEnvironment = !baseDomain || baseDomain.includes('localhost');
      try {
        const url = new URL(origin);
        if (isDevEnvironment && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return origin;
      } catch {
        return null;
      }
      // Allow subdomains of the configured BASE_DOMAIN (e.g., app.example.com, api.example.com).
      if (baseDomain) {
        try {
          const url = new URL(origin);
          if (url.hostname === baseDomain || url.hostname.endsWith(`.${baseDomain}`)) return origin;
        } catch {
          return null;
        }
      }
      return null;
    },
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  }));
}

function registerStructuredRequestLogging(app: ApiApp): void {
  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    const durationMs = Date.now() - start;
    const path = new URL(c.req.url).pathname;
    // Skip noisy health checks from structured logs.
    if (path === '/health') return;
    log.info('http.request', {
      method: c.req.method,
      path,
      status: c.res.status,
      durationMs,
    });
  });
}
