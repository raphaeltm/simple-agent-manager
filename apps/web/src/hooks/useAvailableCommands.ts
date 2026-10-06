import type { SlashCommand } from '@simple-agent-manager/acp-client';
import { CLIENT_COMMANDS,getAllStaticCommands } from '@simple-agent-manager/acp-client';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { cachedCommandsQueryOptions } from '../lib/query-options';
import { useQueryScope } from './useQueryScope';

/**
 * Merges three tiers of slash commands for the project chat input:
 * 1. Client commands (SAM-defined, always available)
 * 2. Static registry commands (well-known agent commands)
 * 3. Cached commands (previously seen from ACP sessions)
 * 4. Live ACP commands (when a session is active, passed in)
 *
 * Deduplicates by command name with priority: live > cached > static > client.
 *
 * Pass `refreshKey` (e.g. sessionId) to re-fetch cached commands whenever the
 * key changes — ensures newly-persisted commands are picked up by subsequent sessions.
 */
export function useAvailableCommands(
  projectId: string,
  liveCommands?: SlashCommand[],
  refreshKey?: string | null,
): { commands: SlashCommand[]; isLoading: boolean; refetch: () => void; persistCommands: (agentType: string, cmds?: SlashCommand[]) => void } {
  const queryScope = useQueryScope();
  const cachedCommandsQuery = useQuery({
    ...cachedCommandsQueryOptions(queryScope, projectId, refreshKey),
    enabled: Boolean(projectId && queryScope),
  });

  // Imperative refetch for callers (e.g. after persisting new commands)
  const refetch = useCallback(() => {
    void cachedCommandsQuery.refetch();
  }, [cachedCommandsQuery]);

  // Allow callers to trigger a cache persist (fire-and-forget)
  const persistCommands = useCallback(
    (agentType: string, cmds: SlashCommand[] = []) => {
      import('../lib/api').then(({ saveCachedCommands }) => {
        saveCachedCommands(
          projectId,
          agentType,
          cmds.map((c) => ({ name: c.name, description: c.description })),
        ).catch(() => { /* best-effort */ });
      });
    },
    [projectId],
  );

  // Merge all sources with dedup (live > cached > static > client)
  const commands = useMemo(() => {
    const seen = new Map<string, SlashCommand>();
    const cachedCommands: SlashCommand[] =
      cachedCommandsQuery.data?.commands?.map((cmd) => ({
        name: cmd.name,
        description: cmd.description,
        source: 'cached' as const,
      })) ?? [];

    // Lowest priority first — higher priority overwrites
    for (const cmd of CLIENT_COMMANDS) seen.set(cmd.name, cmd);
    for (const cmd of getAllStaticCommands()) seen.set(cmd.name, cmd);
    for (const cmd of cachedCommands) seen.set(cmd.name, cmd);
    if (liveCommands) {
      for (const cmd of liveCommands) seen.set(cmd.name, cmd);
    }

    return Array.from(seen.values());
  }, [cachedCommandsQuery.data, liveCommands]);

  return {
    commands,
    isLoading:
      Boolean(projectId && queryScope) &&
      cachedCommandsQuery.isPending &&
      cachedCommandsQuery.data === undefined,
    refetch,
    persistCommands,
  };
}
