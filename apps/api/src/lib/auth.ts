import type { Context, Next } from 'hono';

/**
 * KV namespace for storing GitHub installation data
 */
export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Env {
  // API Authentication
  API_TOKEN: string;

  // Cloudflare configuration
  CF_API_TOKEN: string;
  CF_ZONE_ID: string;
  BASE_DOMAIN: string;

  // Hetzner Cloud
  HETZNER_TOKEN: string;

  // Provider configuration (for mock mode)
  PROVIDER_TYPE?: 'hetzner' | 'devcontainer';
  DNS_TYPE?: 'cloudflare' | 'mock';

  // GitHub App configuration
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_NAME?: string;

  // KV namespace for storing installation data
  GITHUB_INSTALLATIONS?: KVNamespace;
}

/**
 * Bearer token authentication middleware
 */
export const bearerAuth = async (c: Context<{ Bindings: Env }>, next: Next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader) {
    return c.json(
      {
        error: 'unauthorized',
        message: 'Missing Authorization header',
      },
      401
    );
  }

  const token = authHeader.replace('Bearer ', '');

  if (!token || token !== c.env.API_TOKEN) {
    return c.json(
      {
        error: 'unauthorized',
        message: 'Invalid or missing API token',
      },
      401
    );
  }

  await next();
};

/**
 * Generate a random password for basic auth
 */
export function generateAuthPassword(length = 24): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
