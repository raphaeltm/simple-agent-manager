import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { DiagnosisRunner } from '../../../src/durable-objects/diagnosis-runner';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { nodeLifecycleRoutes } from '../../../src/routes/node-lifecycle';
import { nodesRoutes } from '../../../src/routes/nodes';

const app = new Hono<{ Bindings: Env }>();

app.onError((error, context) => {
  if (error instanceof AppError) {
    return context.json(error.toJSON(), error.statusCode as ContentfulStatusCode);
  }
  return context.json({ error: 'INTERNAL_ERROR', message: 'Internal server error' }, 500);
});

// Preserve the production router order from src/index.ts. This makes the Worker
// capability tests prove that the session-authenticated nodes router yields to
// callback-JWT diagnostic routes instead of testing the subrouter in isolation.
app.route('/api/nodes', nodesRoutes);
app.route('/api/nodes', nodeLifecycleRoutes);

export { DiagnosisRunner };
export default app;
