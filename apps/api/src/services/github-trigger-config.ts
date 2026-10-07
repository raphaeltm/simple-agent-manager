/** GitHub configuration replacement shared by REST and MCP updates. */
import { eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';
import * as v from 'valibot';

import * as schema from '../db/schema';
import { errors } from '../middleware/error';
import { GitHubConfigValueSchema } from '../schemas/triggers';

type Database = ReturnType<typeof drizzle<typeof schema>>;

export function parseGitHubTriggerConfig(input: unknown) {
  const parsed = v.safeParse(GitHubConfigValueSchema, input);
  if (!parsed.success) throw errors.badRequest(`Invalid githubConfig: ${parsed.issues[0].message}`);
  return { eventType: parsed.output.eventType, filters: parsed.output.filters ?? {} };
}

export function githubTriggerConfigUpdate(
  db: Database,
  triggerId: string,
  input: unknown,
  now: string
) {
  const config = parseGitHubTriggerConfig(input);
  return db
    .update(schema.githubTriggerConfigs)
    .set({
      eventType: config.eventType,
      filtersJson: JSON.stringify(config.filters),
      updatedAt: now,
    })
    .where(eq(schema.githubTriggerConfigs.triggerId, triggerId));
}

export async function readGitHubTriggerConfig(db: Database, triggerId: string) {
  const config = await db
    .select()
    .from(schema.githubTriggerConfigs)
    .where(eq(schema.githubTriggerConfigs.triggerId, triggerId))
    .get();
  if (!config) throw errors.notFound('GitHub trigger configuration');
  return parseGitHubTriggerConfig({
    eventType: config.eventType,
    filters: JSON.parse(config.filtersJson ?? '{}'),
  });
}
