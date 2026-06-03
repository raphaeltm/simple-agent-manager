import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export async function resolveTaskAgentProfileHint(
  db: Db,
  input: {
    hint: string | null | undefined;
    projectId: string;
    userId: string;
  }
): Promise<string | null> {
  if (!input.hint) return null;

  const resolved = await resolveTaskAgentProfileHints(db, {
    hints: [input.hint],
    projectId: input.projectId,
    userId: input.userId,
  });

  return resolved.get(input.hint) ?? input.hint;
}

export async function resolveTaskAgentProfileHints(
  db: Db,
  input: {
    hints: Array<string | null | undefined>;
    projectId: string;
    userId: string;
  }
): Promise<Map<string, string>> {
  const uniqueHints = Array.from(
    new Set(input.hints.filter((hint): hint is string => typeof hint === 'string' && hint.length > 0))
  );

  if (uniqueHints.length === 0) {
    return new Map();
  }

  try {
    const rows = await db
      .select({
        id: schema.agentProfiles.id,
        name: schema.agentProfiles.name,
      })
      .from(schema.agentProfiles)
      .where(
        and(
          inArray(schema.agentProfiles.id, uniqueHints),
          eq(schema.agentProfiles.userId, input.userId),
          or(eq(schema.agentProfiles.projectId, input.projectId), isNull(schema.agentProfiles.projectId))
        )
      );

    return new Map(rows.map((row) => [row.id, row.name]));
  } catch {
    return new Map();
  }
}
