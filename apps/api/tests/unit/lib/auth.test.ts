import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { bearerAuth, generateAuthPassword, type Env } from '../../../src/lib/auth';

describe('bearerAuth middleware', () => {
  const createTestApp = (apiToken: string) => {
    const app = new Hono<{ Bindings: Env }>();
    app.use('*', bearerAuth);
    app.get('/test', (c) => c.json({ success: true }));

    return {
      app,
      env: {
        API_TOKEN: apiToken,
        CF_API_TOKEN: 'cf-token',
        CF_ZONE_ID: 'zone-id',
        HETZNER_TOKEN: 'hetzner-token',
        BASE_DOMAIN: 'example.com',
      } as Env,
    };
  };

  it('should reject requests without Authorization header', async () => {
    const { app, env } = createTestApp('valid-token');

    const res = await app.request('/test', {}, env);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
    expect(body.message).toContain('Missing Authorization header');
  });

  it('should reject requests with invalid token', async () => {
    const { app, env } = createTestApp('valid-token');

    const res = await app.request(
      '/test',
      {
        headers: { Authorization: 'Bearer invalid-token' },
      },
      env
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('unauthorized');
  });

  it('should accept requests with valid token', async () => {
    const { app, env } = createTestApp('valid-token');

    const res = await app.request(
      '/test',
      {
        headers: { Authorization: 'Bearer valid-token' },
      },
      env
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});

describe('generateAuthPassword', () => {
  it('should generate password of default length', () => {
    const password = generateAuthPassword();
    expect(password).toHaveLength(24);
  });

  it('should generate password of specified length', () => {
    const password = generateAuthPassword(16);
    expect(password).toHaveLength(16);
  });

  it('should generate alphanumeric passwords', () => {
    const password = generateAuthPassword();
    expect(password).toMatch(/^[a-zA-Z0-9]+$/);
  });

  it('should generate unique passwords', () => {
    const passwords = new Set(Array.from({ length: 100 }, () => generateAuthPassword()));
    expect(passwords.size).toBe(100);
  });
});
