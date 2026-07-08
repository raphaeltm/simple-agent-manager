import type { AgentProfileRuntime, CredentialProvider, CredentialSource } from '@simple-agent-manager/shared';
import { type drizzle } from 'drizzle-orm/d1';

import type * as schema from '../db/schema';
import type { Env } from '../env';
import { resolveCredentialSource } from './provider-credentials';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export type WorkspaceRuntime = AgentProfileRuntime;

export interface WorkspaceRuntimeDecisionInput {
  sandboxEnabled: boolean;
  explicitRuntime?: AgentProfileRuntime | null;
  credentialSource?: CredentialSource | null;
}

export interface WorkspaceRuntimeDecision {
  runtime: WorkspaceRuntime;
  reason:
    | 'sandbox-disabled'
    | 'explicit-vm'
    | 'explicit-cf-container'
    | 'user-cloud-credential'
    | 'project-cloud-credential'
    | 'zero-config';
}

export function decideWorkspaceRuntime(input: WorkspaceRuntimeDecisionInput): WorkspaceRuntimeDecision {
  if (!input.sandboxEnabled) {
    return { runtime: 'vm', reason: 'sandbox-disabled' };
  }

  if (input.explicitRuntime === 'vm') {
    return { runtime: 'vm', reason: 'explicit-vm' };
  }
  if (input.explicitRuntime === 'cf-container') {
    return { runtime: 'cf-container', reason: 'explicit-cf-container' };
  }

  if (input.credentialSource === 'user') {
    return { runtime: 'vm', reason: 'user-cloud-credential' };
  }
  if (input.credentialSource === 'project') {
    return { runtime: 'vm', reason: 'project-cloud-credential' };
  }

  return { runtime: 'cf-container', reason: 'zero-config' };
}

export async function resolveWorkspaceRuntime(
  db: Db,
  env: Pick<Env, 'SANDBOX_ENABLED'>,
  input: {
    userId: string;
    projectId?: string | null;
    provider?: CredentialProvider | null;
    explicitRuntime?: AgentProfileRuntime | null;
  }
): Promise<WorkspaceRuntimeDecision> {
  if (env.SANDBOX_ENABLED !== 'true') {
    return decideWorkspaceRuntime({ sandboxEnabled: false, explicitRuntime: input.explicitRuntime });
  }

  const credential = await resolveCredentialSource(
    db,
    input.userId,
    input.provider ?? undefined,
    input.projectId ?? null
  );

  return decideWorkspaceRuntime({
    sandboxEnabled: true,
    explicitRuntime: input.explicitRuntime,
    credentialSource: credential?.credentialSource ?? null,
  });
}
