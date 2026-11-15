import { Hono } from 'hono';

import type { Env } from './env';

/**
 * The API Worker's Hono application. `index.ts` registers every shared middleware and route on
 * it. The self-host build's generated entry (scripts/selfhost/celld-project.ts) appends its
 * self-host-only routes after `index.ts` has been evaluated (`selfhost/hosted-git.ts`); the
 * Cloudflare build's entry is `index.ts`, which never imports those modules.
 */
export const app = new Hono<{ Bindings: Env }>();
