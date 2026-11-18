import { drizzle } from 'drizzle-orm/d1';
import { type Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { getUserId } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import {
  jsonValidator,
  RunDebugDiagnosisSchema,
  SaveDebugDiagnosisIdeaSchema,
} from '../../schemas';
import {
  createDebugDiagnosisRun,
  getDebugDiagnosisRun,
  listDebugDiagnoses,
  retryDebugDiagnosisRun,
  saveDebugDiagnosisAsIdea,
} from '../../services/debug-agent';
import {
  cancelDiagnosisRunner,
  listDiagnosisEvents,
  startDiagnosisRunner,
} from '../../services/diagnosis-runner';
export function registerAdminDiagnosisRoutes(adminObservabilityRoutes: Hono<{ Bindings: Env }>) {
  adminObservabilityRoutes.get('/debug/projects', async (c) => {
    const db = drizzle(c.env.DATABASE, { schema });
    const projects = await db
      .select({ id: schema.projects.id, name: schema.projects.name })
      .from(schema.projects)
      .orderBy(schema.projects.name)
      .limit(200);
    return c.json({ projects });
  });

  adminObservabilityRoutes.get('/diagnoses', async (c) => {
    const result = await listDebugDiagnoses(c.env, {
      summaryOnly: c.req.query('summaryOnly') === 'true',
      errorId: c.req.query('errorId'),
      startTime: c.req.query('startTime'),
      endTime: c.req.query('endTime'),
    });
    return c.json(result);
  });

  adminObservabilityRoutes.post('/diagnoses', jsonValidator(RunDebugDiagnosisSchema), async (c) => {
    const body = c.req.valid('json');
    if (
      (!body.errorId && (!body.startTime || !body.endTime)) ||
      (body.errorId && (body.startTime || body.endTime))
    ) {
      throw errors.badRequest('Provide either errorId or a startTime/endTime window');
    }
    try {
      const run = await createDebugDiagnosisRun(c.env, getUserId(c), body);
      await startDiagnosisRunner(c.env, run.id);
      return c.json({ run }, 202);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Diagnosis failed';
      if (message.includes('budget') || message.includes('token ceiling')) {
        return c.json({ error: 'DEBUG_BUDGET_EXHAUSTED', message }, 429);
      }
      if (message.includes('not found') || message.includes('window'))
        throw errors.badRequest(message);
      throw err;
    }
  });

  adminObservabilityRoutes.get('/diagnosis-runs/:runId', async (c) => {
    const run = await getDebugDiagnosisRun(c.env, c.req.param('runId'));
    if (!run) throw errors.notFound('Diagnosis run not found');
    const cursor = Number(c.req.query('cursor') ?? 0);
    const eventResult = await listDiagnosisEvents(
      c.env,
      run.id,
      Number.isFinite(cursor) && cursor >= 0 ? cursor : 0
    );
    return c.json({ run, ...eventResult });
  });

  adminObservabilityRoutes.get('/diagnosis-runs/:runId/events', async (c) => {
    const run = await getDebugDiagnosisRun(c.env, c.req.param('runId'));
    if (!run) throw errors.notFound('Diagnosis run not found');
    const cursor = Number(c.req.query('cursor') ?? 0);
    return c.json(
      await listDiagnosisEvents(c.env, run.id, Number.isFinite(cursor) && cursor >= 0 ? cursor : 0)
    );
  });

  adminObservabilityRoutes.post('/diagnosis-runs/:runId/cancel', async (c) => {
    const run = await getDebugDiagnosisRun(c.env, c.req.param('runId'));
    if (!run) throw errors.notFound('Diagnosis run not found');
    await cancelDiagnosisRunner(c.env, run.id);
    return c.json({ accepted: true }, 202);
  });

  adminObservabilityRoutes.post('/diagnosis-runs/:runId/retry', async (c) => {
    const run = await retryDebugDiagnosisRun(c.env, c.req.param('runId'), getUserId(c));
    await startDiagnosisRunner(c.env, run.id);
    return c.json({ run }, 202);
  });

  adminObservabilityRoutes.post(
    '/diagnoses/:diagnosisId/idea',
    jsonValidator(SaveDebugDiagnosisIdeaSchema),
    async (c) => {
      const body = c.req.valid('json');
      if (!body.projectId?.trim()) throw errors.badRequest('projectId is required');
      const result = await saveDebugDiagnosisAsIdea(
        c.env,
        c.req.param('diagnosisId'),
        body.projectId,
        getUserId(c),
        body.title
      );
      return c.json(result, 201);
    }
  );
}
