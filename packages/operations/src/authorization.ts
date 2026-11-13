import { AppError } from '@simple-agent-manager/worker-core';

import { OperationError } from './errors';
import type { OperationContext } from './types';

export async function authorizeProjectOperation(
  ctx: OperationContext,
  projectId: string,
  capability: 'task:write' | null = null
): Promise<void> {
  const requiredScope = capability ? 'sam.write' : 'sam.read';
  if (!ctx.actor.scopes.has(requiredScope)) {
    throw new OperationError('forbidden', `Missing ${requiredScope} scope`);
  }
  if (ctx.actor.workspace && ctx.actor.workspace.projectId !== projectId) {
    throw new OperationError('forbidden', 'Project does not match workspace token');
  }
  try {
    if (capability) {
      await ctx.ports.access.requireProjectCapability(projectId, ctx.actor.userId, capability);
    } else {
      await ctx.ports.access.requireProjectAccess(projectId, ctx.actor.userId);
    }
  } catch (error) {
    if (error instanceof AppError) {
      if (error.statusCode === 403) {
        throw new OperationError('forbidden', 'Project capability is required');
      }
      if (error.statusCode === 404) {
        throw new OperationError('not_found', 'Project not found');
      }
    }
    throw new OperationError('unavailable', 'Project authorization is unavailable');
  }
}
