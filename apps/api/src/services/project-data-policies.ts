/**
 * Policy service functions — extracted from project-data.ts for file size compliance.
 * Re-exported from project-data.ts so consumers don't need to change imports.
 */
import type { PolicyCategory, PolicyScope, PolicySource } from '@simple-agent-manager/shared';

import type { ProjectData } from '../durable-objects/project-data';
import type { Env } from '../env';

async function getStub(env: Env, projectId: string): Promise<DurableObjectStub<ProjectData>> {
  const id = env.PROJECT_DATA.idFromName(projectId);
  const stub = env.PROJECT_DATA.get(id) as DurableObjectStub<ProjectData>;
  await stub.ensureProjectId(projectId);
  return stub;
}

export async function createPolicy(
  env: Env, projectId: string,
  category: PolicyCategory, title: string, content: string,
  source: PolicySource, sourceSessionId: string | null, confidence: number,
  scope: PolicyScope = 'always', expiresAt: number | null = null,
) {
  const stub = await getStub(env, projectId);
  return stub.createPolicy(
    category, title, content, source, sourceSessionId, confidence, scope, expiresAt,
  );
}

export async function getPolicy(env: Env, projectId: string, policyId: string) {
  const stub = await getStub(env, projectId);
  return stub.getPolicy(policyId);
}

export async function listPolicies(
  env: Env, projectId: string, category: string | null, activeOnly: boolean, limit: number, offset: number,
) {
  const stub = await getStub(env, projectId);
  return stub.listPolicies(category, activeOnly, limit, offset);
}

export async function updatePolicy(
  env: Env, projectId: string, policyId: string,
  updates: {
    title?: string; content?: string; category?: PolicyCategory; active?: boolean;
    confidence?: number; scope?: PolicyScope; expiresAt?: number | null;
  },
) {
  const stub = await getStub(env, projectId);
  return stub.updatePolicy(policyId, updates);
}

export async function removePolicy(env: Env, projectId: string, policyId: string) {
  const stub = await getStub(env, projectId);
  return stub.removePolicy(policyId);
}

export async function getActivePolicies(env: Env, projectId: string) {
  const stub = await getStub(env, projectId);
  return stub.getActivePolicies();
}
