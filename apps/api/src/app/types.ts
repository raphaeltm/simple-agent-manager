import type { Hono } from 'hono';

import type { Env } from '../env';

export type ApiApp = Hono<{ Bindings: Env }>;
