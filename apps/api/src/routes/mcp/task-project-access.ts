import type { drizzle } from 'drizzle-orm/d1';

import type * as schema from '../../db/schema';
import { AppError } from '../../middleware/error';
import { requireProjectCapability } from '../../middleware/project-auth';
import { INVALID_PARAMS, jsonRpcError, type JsonRpcResponse } from './_helpers';

export async function requireMcpTaskWriteProject(
  db: ReturnType<typeof drizzle<typeof schema>>,
  projectId: string,
  userId: string,
  requestId: string | number | null
): Promise<typeof schema.projects.$inferSelect | JsonRpcResponse> {
  try {
    return await requireProjectCapability(db, projectId, userId, 'task:write');
  } catch (err) {
    if (err instanceof AppError) {
      return jsonRpcError(requestId, INVALID_PARAMS, err.message);
    }
    throw err;
  }
}
