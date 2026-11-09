import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import * as v from 'valibot';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { errors } from '../../middleware/error';
import { resolveAdminSetting } from '../../services/admin-settings';
import { completeBuildContext, reserveBuildContext } from '../../services/build-context-state';
import {
  createBuildContextUpload,
  verifyBuildContextObject,
} from '../../services/build-context-upload';
import { assertAgentDeploymentAllowedForProfile } from '../../services/deployment-control';
import { recordDeploymentPublishJobLifecycleEventBestEffort } from '../../services/project-lifecycle-events';
import { verifyWorkspacePublishCallback } from './_callback-auth';

const requestSchema = v.object({
  attempt: v.pipe(v.number(), v.integer(), v.minValue(1)),
  sizeBytes: v.pipe(v.number(), v.integer(), v.minValue(1)),
  sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  durationMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});
const buildContextCallbackRoute = new Hono<{ Bindings: Env }>();
for (const operation of ['init', 'complete'] as const) {
  buildContextCallbackRoute.post(
    `/:id/deployment-publish-jobs/:jobId/context/${operation}`,
    async (c) => {
      const verified = await verifyWorkspacePublishCallback(
        c,
        'deployment_publish_job_event',
        'Invalid token scope for build context'
      );
      const parsed = v.safeParse(requestSchema, await c.req.json().catch(() => null));
      if (!parsed.success)
        throw errors.badRequest(
          'Context requires a positive attempt, sizeBytes, and lowercase sha256 digest'
        );
      const body = parsed.output;
      const j = schema.deploymentPublishJobs;
      const [job] = await verified.db
        .select()
        .from(j)
        .where(
          and(
            eq(j.id, c.req.param('jobId')),
            eq(j.projectId, verified.projectId),
            eq(j.workspaceId, verified.workspaceId),
            eq(j.requestedBy, verified.userId)
          )
        )
        .limit(1);
      if (!job) throw errors.notFound('Publish job');
      if (!job.agentProfileId) throw errors.forbidden('Publish job has no deployment profile');
      const policy = await assertAgentDeploymentAllowedForProfile(
        verified.db,
        verified.projectId,
        job.environmentName,
        job.agentProfileId
      );
      if ('error' in policy || policy.environmentId !== job.environmentId)
        throw errors.forbidden('Publish job deployment policy no longer permits this environment');
      if (
        body.sizeBytes >
        Number(await resolveAdminSetting(c.env, 'deployments.buildContextMaxBytes'))
      )
        throw errors.badRequest('Build context exceeds configured maximum bytes');
      const owner = {
        id: job.id,
        projectId: verified.projectId,
        workspaceId: verified.workspaceId,
        requestedBy: verified.userId,
        environmentId: job.environmentId,
        attempt: body.attempt,
      };
      await verified.assertCurrent();
      let result;
      let upload;
      if (operation === 'init') {
        // Generate first: a credential/signing failure must not strand a reserved slot.
        upload = await createBuildContextUpload(
          c.env,
          owner,
          body,
          Number(await resolveAdminSetting(c.env, 'deployments.buildContextUploadTtlSeconds'))
        );
        await verified.assertCurrent();
        result = await reserveBuildContext(verified.db, owner, body);
      } else {
        if (!(await verifyBuildContextObject(c.env, owner, body)))
          throw errors.badRequest(
            'Context object is missing or its size/recorded sha256 does not match'
          );
        await verified.assertCurrent();
        result = await completeBuildContext(verified.db, owner, body);
      }
      if (!result)
        throw errors.conflict(
          'Context job status, executor, attempt, or descriptor no longer matches'
        );
      c.executionCtx.waitUntil(
        recordDeploymentPublishJobLifecycleEventBestEffort(c.env, {
          projectId: job.projectId,
          publishJobId: job.id,
          environmentId: job.environmentId,
          status: result.status,
          fromStatus: job.status,
          currentStep: result.status,
          nodeId: job.nodeId,
          workspaceId: job.workspaceId,
          terminal: false,
          source: `build_context.${operation}`,
          occurredAt: Date.now(),
        })
      );
      await verified.assertCurrent();
      return c.json({ ok: true, status: result.status, ...upload });
    }
  );
}
export { buildContextCallbackRoute };
