/** PROTOTYPE — new-chat profile picker directions. Do not merge to main. */
import type { AgentProfile } from '@simple-agent-manager/shared';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { request } from '../../../lib/api/client';
import type { ProfileUsage } from './model';
import { predictedProfileId } from './model';

/**
 * Hypothetical endpoint: per-user profile usage for this project, derived from
 * tasks.agent_profile_hint (manual chats) and triggered/dispatched tasks (automations).
 */
export function useProfileUsage(projectId: string) {
  return useQuery({
    queryKey: ['prototype', 'profile-usage', projectId],
    queryFn: () => request<ProfileUsage>(`/api/projects/${projectId}/agent-profiles/usage`),
    staleTime: 60_000,
  });
}

/** Replace the alphabetical default with the profile you used last — once. */
export function usePredictedDefault(
  profiles: AgentProfile[],
  usage: ProfileUsage | undefined,
  onProfileChange: (profileId: string | null) => void
) {
  const applied = useRef(false);
  useEffect(() => {
    if (applied.current || !usage || profiles.length === 0) return;
    applied.current = true;
    onProfileChange(predictedProfileId(profiles, usage));
  }, [onProfileChange, profiles, usage]);
}

function readIds(key: string, fallback: string[]): string[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')
      ? parsed
      : fallback;
  } catch {
    return fallback;
  }
}

/** Per-person list preference (pins / hidden). A real version is a per-user server pref. */
export function useIdList(key: string, fallback: string[]) {
  const [ids, setIds] = useState<string[]>(() => readIds(key, fallback));
  const update = useCallback(
    (next: string[]) => {
      setIds(next);
      localStorage.setItem(key, JSON.stringify(next));
    },
    [key]
  );
  const toggle = useCallback(
    (id: string) => update(ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id]),
    [ids, update]
  );
  const addMany = useCallback(
    (more: string[]) => update(Array.from(new Set([...ids, ...more]))),
    [ids, update]
  );
  return { ids, toggle, addMany };
}
