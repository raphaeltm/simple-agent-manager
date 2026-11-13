import {
  decideWorkspaceRuntime,
  type WorkspaceRuntimeDecision,
} from '@simple-agent-manager/scheduler-core';
import type { AgentProfileRuntime, CredentialProvider } from '@simple-agent-manager/shared';
import { type drizzle } from 'drizzle-orm/d1';

import type * as schema from '../db/schema';
import type { Env } from '../env';
import { resolveCredentialSource } from './provider-credentials';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export async function resolveWorkspaceRuntime(
  db: Db,
  env: Pick<Env, 'CF_CONTAINER_ENABLED' | 'SANDBOX_ENABLED'>,
  input: {
    userId: string;
    projectId?: string | null;
    provider?: CredentialProvider | null;
    explicitRuntime?: AgentProfileRuntime | null;
  }
): Promise<WorkspaceRuntimeDecision> {
  if ((env.CF_CONTAINER_ENABLED ?? env.SANDBOX_ENABLED) !== 'true') {
    return decideWorkspaceRuntime({
      containerEnabled: false,
      explicitRuntime: input.explicitRuntime,
    });
  }

  const credential = await resolveCredentialSource(
    db,
    input.userId,
    input.provider ?? undefined,
    input.projectId ?? null
  );

  return decideWorkspaceRuntime({
    containerEnabled: true,
    explicitRuntime: input.explicitRuntime,
    credentialSource: credential?.credentialSource ?? null,
  });
}
