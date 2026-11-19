/** Durable retry of the small ProjectData cleanup after sleep is wakeable in D1. */
import { and, eq, isNotNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import * as projectDataService from './project-data';
import { DEFAULT_SESSION_SLEEP_RETRY_DELAY_MS } from './session-snapshot-artifacts';

export async function finishConfirmedSleepAttention(
  env: Env,
  projectId: string,
  chatSessionId: string,
  workspaceId: string
): Promise<boolean> {
  const db = drizzle(env.DATABASE, { schema });
  const identity = and(
    eq(schema.sessionSnapshots.projectId, projectId),
    eq(schema.sessionSnapshots.chatSessionId, chatSessionId),
    eq(schema.sessionSnapshots.workspaceId, workspaceId),
    eq(schema.sessionSnapshots.sleepStatus, 'sleeping'),
    isNotNull(schema.sessionSnapshots.sleepingAt)
  );
  try {
    const applied = await projectDataService.finishConfirmedSessionSleep(
      env,
      projectId,
      chatSessionId,
      workspaceId
    );
    await db.update(schema.sessionSnapshots).set({ sleepAfter: null }).where(identity);
    return applied;
  } catch (error) {
    await db
      .update(schema.sessionSnapshots)
      .set({
        sleepAfter: new Date(
          Date.now() +
            parsePositiveInt(env.SESSION_SLEEP_RETRY_DELAY_MS, DEFAULT_SESSION_SLEEP_RETRY_DELAY_MS)
        ).toISOString(),
      })
      .where(identity);
    log.warn('session_sleep.confirmed_attention_cleanup_failed', {
      chatSessionId,
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
