import type { Context } from 'hono';
import { decodeJwt } from 'jose';

import type { Env } from '../../env';
import { extractBearerToken } from '../../lib/auth-helpers';
import { readRequestJsonRecord, RequestBodyTooLargeError } from '../../lib/runtime-validation';
import { AppError, errors } from '../../middleware/error';
import { resolveAdminSetting } from '../../services/admin-settings-resolution';
import { verifyPublishJobToken } from '../../services/publish-job-token';
import type { WorkspaceDeletionCallbackKind } from '../../services/workspace-deletion-callback-signal';
import { verifyWorkspacePublishCallback } from './_callback-auth';

async function readPublishBody(c: Context<{ Bindings: Env }>, context: string) {
  try {
    return await readRequestJsonRecord(
      c.req.raw,
      context,
      Number(await resolveAdminSetting(c.env, 'deployments.publishCallbackMaxBodyBytes'))
    );
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError)
      throw new AppError(
        413,
        'PAYLOAD_TOO_LARGE',
        'Publish callback body exceeds the configured byte limit'
      );
    throw errors.badRequest('Publish callback JSON object required');
  }
}

/** Only the existing events, artifact, and release sinks opt in. Context upload
 * and registry credentials remain source-workspace-only. The unverified scope
 * is routing information; both branches perform full signature verification. */
export async function verifyPublishCallback(
  c: Context<{ Bindings: Env }>,
  logPrefix: WorkspaceDeletionCallbackKind,
  scopeErrorMessage: string
) {
  const authorization = c.req.header('Authorization');
  let jobScope = false;
  try {
    jobScope = decodeJwt(extractBearerToken(authorization)).scope === 'publish-job';
  } catch {
    /* verifier returns 401 */
  }
  if (!jobScope) {
    const verified = await verifyWorkspacePublishCallback(c, logPrefix, scopeErrorMessage);
    return { ...verified, job: null, body: await readPublishBody(c, logPrefix) };
  }
  const token = extractBearerToken(authorization);
  const { db, job } = await verifyPublishJobToken(c.env, token);
  if (
    job.projectId !== c.req.param('id') ||
    (c.req.param('jobId') && job.id !== c.req.param('jobId'))
  )
    throw errors.forbidden('Publish job identity does not match route');
  const fields = await readPublishBody(c, logPrefix);
  if (logPrefix !== 'deployment_publish_job_event') {
    if (fields.environmentId !== job.environmentId || fields.environment !== job.environmentName)
      throw errors.forbidden('Publish job environment does not match');
    const submittedBy = fields.submittedBy as Record<string, unknown> | undefined;
    if (logPrefix === 'compose_publish_release') {
      if (
        fields.publishJobId !== job.id ||
        fields.attempt !== job.attempt ||
        submittedBy?.agentProfileId !== job.agentProfileId ||
        (submittedBy?.taskId ?? null) !== job.taskId
      )
        throw errors.forbidden('Release must match the authenticated job and attempt');
    } else if (fields.agentProfileId !== job.agentProfileId) {
      throw errors.forbidden('Publish job agent profile does not match');
    }
    const artifacts = logPrefix === 'compose_publish_release' ? fields.services : fields.artifacts;
    if (Array.isArray(artifacts)) {
      const prefix = `compose-image-artifacts/${job.projectId}/${job.environmentId}/${job.workspaceId}/${job.id}-${job.attempt}/`;
      for (const artifact of artifacts) {
        if (!artifact || typeof artifact.r2Key !== 'string' || !artifact.r2Key.startsWith(prefix))
          throw errors.forbidden('Artifact must belong to this job and attempt');
      }
    }
  }
  return {
    projectId: job.projectId,
    workspaceId: job.workspaceId,
    userId: job.requestedBy,
    db,
    job,
    body: fields,
    // A successful release links its release before provisioning. Its job stays
    // nonterminal until the builder's final event; no workspace read is involved.
    assertCurrent: async () => {
      await verifyPublishJobToken(c.env, token);
    },
  };
}
