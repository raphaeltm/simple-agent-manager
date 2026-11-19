/**
 * Mention enrichment service — detects @mentions of agent profiles in user messages
 * and appends hidden context for the receiving agent.
 *
 * The @mention is a signal, not a command. The enrichment tells the agent which
 * profiles were mentioned and how to dispatch work to them via dispatch_task.
 * The agent decides whether and how to act on it.
 */
import type { MentionMatch, ResolvedAgentProfile } from '@simple-agent-manager/shared';
import { extractMentions, formatMentionName } from '@simple-agent-manager/shared';
import type { drizzle } from 'drizzle-orm/d1';

import type * as dbSchema from '../db/schema';
import type { Env } from '../env';
import { AppError } from '../middleware/error';
import { resolveAgentProfile } from './agent-profiles';

type Db = ReturnType<typeof drizzle<typeof dbSchema>>;
type ProfileEnv = Pick<Env, 'DEFAULT_TASK_AGENT_TYPE'>;

export type { MentionMatch } from '@simple-agent-manager/shared';
export { extractMentions } from '@simple-agent-manager/shared';

export interface ResolvedMention {
  mention: MentionMatch;
  profile: ResolvedAgentProfile;
}

export interface EnrichmentResult {
  /** Original message, unchanged */
  cleanMessage: string;
  /** Message with appended agent profile context (or same as clean if no mentions resolved) */
  enrichedMessage: string;
  /** Mentions that resolved to real profiles */
  resolvedMentions: ResolvedMention[];
}

/**
 * Build the hidden instruction block appended to the enriched message.
 */
function buildMentionContext(resolved: ResolvedMention[]): string {
  const lines = resolved.map(({ profile }) => {
    const desc = profile.systemPromptAppend ? ` — "${profile.systemPromptAppend}"` : '';
    return `- ${formatMentionName(profile.profileName ?? '')}: ${profile.agentType}${desc} (profileId: ${profile.profileId})`;
  });

  return (
    '\n\n---\n' +
    '[SAM: The user mentioned the following agent profiles. ' +
    'You may use the dispatch_task MCP tool with the profileId to delegate work to them.]\n' +
    lines.join('\n') +
    '\n[End of mention context]'
  );
}

/**
 * Detect @mentions in a message, resolve them against agent profiles,
 * and return both the original clean message and an enriched version
 * with hidden agent context appended.
 */
export async function enrichMessageWithMentions(
  message: string,
  db: Db,
  projectId: string,
  userId: string,
  env: ProfileEnv
): Promise<EnrichmentResult> {
  const mentions = extractMentions(message);

  if (mentions.length === 0) {
    return { cleanMessage: message, enrichedMessage: message, resolvedMentions: [] };
  }

  const resolved: ResolvedMention[] = [];

  for (const mention of mentions) {
    let profile: ResolvedAgentProfile;
    try {
      profile = await resolveAgentProfile(db, projectId, mention.name, userId, env);
    } catch (error) {
      // Mentions are optional hints. Explicit profile selection remains strict.
      if (error instanceof AppError && error.statusCode === 404 && error.error === 'NOT_FOUND') {
        continue;
      }
      throw error;
    }
    // Only include mentions that resolved to an actual named profile
    if (profile.profileId && profile.profileName) {
      resolved.push({ mention, profile });
    }
  }

  if (resolved.length === 0) {
    return { cleanMessage: message, enrichedMessage: message, resolvedMentions: [] };
  }

  return {
    cleanMessage: message,
    enrichedMessage: message + buildMentionContext(resolved),
    resolvedMentions: resolved,
  };
}
