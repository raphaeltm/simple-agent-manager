import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { finishConfirmedSleepAttention } from '../services/session-sleep-attention';

export async function repairConfirmedSleepAttention(
  env: Env,
  now: Date,
  batchSize: number
): Promise<void> {
  const db = drizzle(env.DATABASE, { schema });
  const rows = await db
    .select({
      projectId: schema.sessionSnapshots.projectId,
      chatSessionId: schema.sessionSnapshots.chatSessionId,
      workspaceId: schema.sessionSnapshots.workspaceId,
    })
    .from(schema.sessionSnapshots)
    .where(
      and(
        eq(schema.sessionSnapshots.sleepStatus, 'sleeping'),
        isNotNull(schema.sessionSnapshots.sleepingAt),
        lte(schema.sessionSnapshots.sleepAfter, now.toISOString())
      )
    )
    .limit(batchSize);
  for (const row of rows)
    if (row.projectId && row.workspaceId)
      await finishConfirmedSleepAttention(env, row.projectId, row.chatSessionId, row.workspaceId);
}
