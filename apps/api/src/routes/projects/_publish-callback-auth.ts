import type { Context } from 'hono';
import { decodeJwt } from 'jose';

import type { Env } from '../../env';
import { extractBearerToken } from '../../lib/auth-helpers';
import { errors } from '../../middleware/error';
import { verifyPublishJobToken } from '../../services/publish-job-token';
import type { WorkspaceDeletionCallbackKind } from '../../services/workspace-deletion-callback-signal';
import { verifyWorkspacePublishCallback } from './_callback-auth';

/** Only the existing events, artifact, and release sinks opt in. Context upload
 * and registry credentials remain source-workspace-only. The unverified scope
 * is routing information; both branches perform full signature verification. */
export async function verifyPublishCallback(
  c: Context<{ Bindings: Env }>,
  logPrefix: WorkspaceDeletionCallbackKind,
  scopeErrorMessage: string
) {
  const token = extractBearerToken(c.req.header('Authorization'));
  let jobScope = false;
  try {
    jobScope = decodeJwt(token).scope === 'publish-job';
  } catch {
    /* verifier returns 401 */
  }
  if (!jobScope)
    return {
      ...(await verifyWorkspacePublishCallback(c, logPrefix, scopeErrorMessage)),
      job: null,
    };
  const { db, job } = await verifyPublishJobToken(c.env, token);
  if (
    job.projectId !== c.req.param('id') ||
    (c.req.param('jobId') && job.id !== c.req.param('jobId'))
  )
    throw errors.forbidden('Publish job identity does not match route');
  const body: unknown = await c.req.raw
    .clone()
    .json()
    .catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw errors.badRequest('Publish callback body required');
  const fields = body as Record<string, unknown>;
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
    // A successful release links its release before provisioning. Its job stays
    // nonterminal until the builder's final event; no workspace read is involved.
    assertCurrent: async () => {
      await verifyPublishJobToken(c.env, token);
    },
  };
}
