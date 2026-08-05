import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { DiagnosisRunner } from '../../../src/durable-objects/diagnosis-runner';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { nodeDiagnosticIncidentRoutes } from '../../../src/routes/node-diagnostic-incidents';

const app = new Hono<{ Bindings: Env }>();

app.onError((error, context) => {
  if (error instanceof AppError) {
    return context.json(error.toJSON(), error.statusCode as ContentfulStatusCode);
  }
  return context.json({ error: 'INTERNAL_ERROR', message: 'Internal server error' }, 500);
});

// This is the production callback-JWT subrouter, mounted at the same base path
// as src/index.ts without importing the unrelated Container runtime.
app.route('/api/nodes', nodeDiagnosticIncidentRoutes);

export { DiagnosisRunner };
export default app;
