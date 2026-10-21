import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';

import { request } from '../lib/api/client';
import { SAM_SETTINGS_POLL_MS } from '../lib/poll-intervals';
import { useQueryScope } from './useQueryScope';

export interface SamSettings {
  enabled: boolean;
  available: boolean;
}
const SETTINGS_CHANNEL = 'sam-account-settings';

export function useSamSettings() {
  const scope = useQueryScope();
  const client = useQueryClient();
  const key = ['auth', scope, 'sam', 'settings'] as const;
  const query = useQuery({
    queryKey: key,
    queryFn: () => request<SamSettings>('/api/sam/settings'),
    enabled: Boolean(scope),
    refetchInterval: SAM_SETTINGS_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always',
    retry: false,
  });
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined' || !scope) return;
    const channel = new BroadcastChannel(SETTINGS_CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data === scope) void client.invalidateQueries({ queryKey: ['auth', scope, 'sam'] });
    };
    return () => channel.close();
  }, [client, scope]);
  const setEnabled = useCallback(
    async (enabled: boolean) => {
      const result = await request<SamSettings>('/api/sam/settings', {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      });
      client.setQueryData(['auth', scope, 'sam', 'settings'], result);
      if (typeof BroadcastChannel !== 'undefined') {
        const channel = new BroadcastChannel(SETTINGS_CHANNEL);
        channel.postMessage(scope);
        channel.close();
      }
      await client.invalidateQueries({ queryKey: ['auth', scope, 'sam', 'turns'] });
    },
    [client, scope]
  );
  return {
    ...query,
    enabled: query.data?.enabled === true && query.data.available && !query.isError,
    setEnabled,
  };
}
