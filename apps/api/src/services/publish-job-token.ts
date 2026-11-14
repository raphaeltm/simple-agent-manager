import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { importPKCS8, SignJWT } from 'jose';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { errors } from '../middleware/error';
import { PUBLISH_JOB_TERMINAL_STATUSES } from './deployment-publish-jobs';
import { verifyPublishJobClaims } from './jwt';

const AUDIENCE = 'workspace-callback';
export interface PublishJobClaims {
  jobId: string;
  projectId: string;
  environmentId: string;
  agentProfileId: string;
  attempt: number;
}

/** Deliberately separate from the generic callback verifier: all other callback
 * sinks continue rejecting this scope, including credential/renewal routes. */
export async function signPublishJobToken(
  env: Env,
  claims: PublishJobClaims,
  deadline: number
): Promise<string> {
  if (deadline <= Date.now()) throw errors.conflict('Publish job deadline has elapsed');
  return new SignJWT({ ...claims, scope: 'publish-job', type: 'callback' })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(`https://api.${env.BASE_DOMAIN}`)
    .setAudience(AUDIENCE)
    .setSubject(claims.jobId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(deadline / 1000))
    .sign(await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256'));
}

export async function verifyPublishJobToken(env: Env, token: string) {
  const payload = await verifyPublishJobClaims(env, token);
  const db = drizzle(env.DATABASE, { schema });
  const j = schema.deploymentPublishJobs;
  const [job] = await db
    .select()
    .from(j)
    .where(
      and(
        eq(j.id, payload.jobId),
        eq(j.projectId, payload.projectId),
        eq(j.environmentId, payload.environmentId),
        eq(j.agentProfileId, payload.agentProfileId),
        eq(j.attempt, payload.attempt),
        eq(j.executor, 'cloudflare'),
        eq(j.contextShadow, false)
      )
    )
    .limit(1);
  if (!job || PUBLISH_JOB_TERMINAL_STATUSES.has(job.status))
    throw errors.gone('Publish job is terminal, missing, or its attempt changed');
  return { db, job };
}
