import type {
  TriggerResponse,
  TriggerSourceType,
  TriggerStatus,
} from '@simple-agent-manager/shared';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { cronToHumanReadable } from './cron-utils';

type Database = ReturnType<typeof drizzle<typeof schema>>;

export interface TriggerListOptions {
  status?: TriggerStatus;
  sourceType?: TriggerSourceType;
  limit?: number;
}

export function toTriggerResponse(row: schema.TriggerRow): TriggerResponse {
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    name: row.name,
    description: row.description,
    status: row.status as TriggerStatus,
    sourceType: row.sourceType as TriggerSourceType,
    cronExpression: row.cronExpression,
    cronTimezone: row.cronTimezone ?? 'UTC',
    skipIfRunning: row.skipIfRunning,
    promptTemplate: row.promptTemplate,
    agentProfileId: row.agentProfileId,
    skillId: row.skillId,
    taskMode: (row.taskMode ?? 'task') as TriggerResponse['taskMode'],
    vmSizeOverride: row.vmSizeOverride,
    maxConcurrent: row.maxConcurrent,
    lastTriggeredAt: row.lastTriggeredAt,
    triggerCount: row.triggerCount,
    nextFireAt: row.nextFireAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    cronHumanReadable: row.cronExpression
      ? cronToHumanReadable(row.cronExpression, row.cronTimezone ?? 'UTC')
      : undefined,
  };
}

export async function listTriggerRows(
  db: Database,
  projectId: string,
  options: TriggerListOptions = {}
): Promise<schema.TriggerRow[]> {
  const conditions: SQL[] = [eq(schema.triggers.projectId, projectId)];
  if (options.status) conditions.push(eq(schema.triggers.status, options.status));
  if (options.sourceType) conditions.push(eq(schema.triggers.sourceType, options.sourceType));

  const query = db
    .select()
    .from(schema.triggers)
    .where(and(...conditions))
    .orderBy(desc(schema.triggers.createdAt));

  return options.limit === undefined ? query : query.limit(options.limit);
}
