import type { SlashCommand } from '@simple-agent-manager/acp-client';
import { CLIENT_COMMANDS,getAllStaticCommands } from '@simple-agent-manager/acp-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getCachedCommands } from '../lib/api';

/**
 * Merges three tiers of slash commands for the project chat input:
 * 1. Client commands (SAM-defined, always available)
 * 2. Static registry commands (well-known agent commands)
 * 3. Cached commands (previously seen from ACP sessions)
 * 4. Live ACP commands (when a session is active, passed in)
 *
 * Deduplicates by command name with priority: live > cached > static > client.
 */
export function useAvailableCommands(
  projectId: string,
  liveCommands?: SlashCommand[],
): { commands: SlashCommand[]; isLoading: boolean; persistCommands: (agentType: string, cmds: SlashCommand[]) => void } {
  const [cachedCommands, setCachedCommands] = useState<SlashCommand[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const fetchedRef = useRef<string | null>(null);

  // Fetch cached commands from the API on mount / projectId change
  useEffect(() => {
    if (fetchedRef.current === projectId) return;
    fetchedRef.current = projectId;

    let cancelled = false;
    setIsLoading(true);
    getCachedCommands(projectId)
      .then((result) => {
        if (cancelled) return;
        setCachedCommands(
          result.commands.map((cmd) => ({
            name: cmd.name,
            description: cmd.description,
            source: 'cached' as const,
          })),
        );
      })
      .catch(() => {
        // Non-fatal — static commands are still available
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => { cancelled = true; };
  }, [projectId]);

  // Allow callers to trigger a cache persist (fire-and-forget)
  const persistCommands = useCallback(
    (agentType: string, cmds: SlashCommand[]) => {
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

    // Lowest priority first — higher priority overwrites
    for (const cmd of CLIENT_COMMANDS) seen.set(cmd.name, cmd);
    for (const cmd of getAllStaticCommands()) seen.set(cmd.name, cmd);
    for (const cmd of cachedCommands) seen.set(cmd.name, cmd);
    if (liveCommands) {
      for (const cmd of liveCommands) seen.set(cmd.name, cmd);
    }

    return Array.from(seen.values());
  }, [cachedCommands, liveCommands]);

  return { commands, isLoading, persistCommands };
}
