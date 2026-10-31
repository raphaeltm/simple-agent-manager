/**
 * Settings → Agents → Agent settings: one card per agent you can run, plus a compact
 * line for agents with no account yet. Defaults are per agent, never per
 * account.
 */
import type { AgentInfo, AgentType, SaveAgentSettingsRequest } from '@simple-agent-manager/shared';
import { Alert, Skeleton } from '@simple-agent-manager/ui';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useCallback } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import { deleteAgentSettings, saveAgentSettings } from '../../lib/api';
import {
  agentCatalogQueryOptions,
  agentQueryKeys,
  agentSettingsQueryOptions,
} from '../../lib/query-options';
import { AgentSettingsCard } from '../AgentSettingsCard';
import { isProviderInUse, type ProviderAccounts } from './account-model';
import { ProviderMark } from './AccountBits';
import { getAccountProvider } from './provider-meta';

export interface AgentDefaultsSectionProps {
  /** Account groups, to tell which agents can run today. */
  groups: ProviderAccounts[] | null;
  onConnect: (agentId: string) => void;
}

export function AgentDefaultsSection({ groups, onConnect }: Readonly<AgentDefaultsSectionProps>) {
  const queryScope = useQueryScope();
  const queryClient = useQueryClient();
  const catalog = useQuery({
    ...agentCatalogQueryOptions(queryScope),
    enabled: Boolean(queryScope),
  });
  const agents: AgentInfo[] = catalog.data ?? [];
  const settings = useQueries({
    queries: agents.map((agent) => ({
      ...agentSettingsQueryOptions(queryScope, agent.id),
      enabled: Boolean(queryScope),
    })),
  });

  const handleSave = useCallback(
    async (agentType: AgentType, data: SaveAgentSettingsRequest) => {
      const result = await saveAgentSettings(agentType, data);
      queryClient.setQueryData(agentQueryKeys.settings(queryScope, agentType), result);
    },
    [queryClient, queryScope]
  );

  const handleReset = useCallback(
    async (agentType: AgentType) => {
      await deleteAgentSettings(agentType);
      await queryClient.invalidateQueries({
        queryKey: agentQueryKeys.settings(queryScope, agentType),
      });
    },
    [queryClient, queryScope]
  );

  if (catalog.data === undefined) {
    if (catalog.error) {
      return (
        <Alert variant="error">
          {catalog.error instanceof Error ? catalog.error.message : 'Failed to load agents'}
        </Alert>
      );
    }
    return (
      <div className="grid gap-3 md:grid-cols-2">
        <Skeleton width="100%" height="18rem" borderRadius="var(--sam-radius-lg)" />
        <Skeleton width="100%" height="18rem" borderRadius="var(--sam-radius-lg)" />
      </div>
    );
  }

  const usable = (agent: AgentInfo) => {
    const group = groups?.find((candidate) => candidate.provider.id === agent.id);
    return agent.configured || (group ? isProviderInUse(group) : false);
  };
  const active = agents.filter(usable);
  const idle = agents.filter((agent) => !usable(agent));

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {active.length > 0 ? (
        <div className="grid items-start gap-3 md:grid-cols-2">
          {active.map((agent) => {
            const query = settings[agents.indexOf(agent)];
            // Never render a card before its saved settings arrive: the form
            // would show defaults that are not yours and could save over them.
            if (!query || query.isPending) {
              return (
                <Skeleton
                  key={agent.id}
                  width="100%"
                  height="18rem"
                  borderRadius="var(--sam-radius-lg)"
                />
              );
            }
            if (query.isError) {
              return (
                <Alert key={agent.id} variant="error">
                  Couldn’t load your {agent.name} settings.{' '}
                  <button
                    type="button"
                    onClick={() => void query.refetch()}
                    className="cursor-pointer border-none bg-transparent p-0 text-[length:inherit] text-inherit underline"
                  >
                    Retry
                  </button>
                </Alert>
              );
            }
            return (
              <AgentSettingsCard
                key={agent.id}
                agent={agent}
                settings={query.data ?? null}
                onSave={handleSave}
                onReset={handleReset}
              />
            );
          })}
        </div>
      ) : (
        <p className="m-0 rounded-lg border border-dashed border-border-default p-4 text-sm text-fg-muted">
          Connect an agent account and its settings appear here.
        </p>
      )}
      {idle.length > 0 && (
        <ul className="m-0 flex list-none flex-col overflow-hidden rounded-lg border border-border-default p-0">
          {idle.map((agent, index) => {
            const provider = getAccountProvider('agent', agent.id);
            return (
              <li
                key={agent.id}
                className={`flex min-w-0 items-center gap-3 px-4 py-2.5 ${
                  index > 0 ? 'border-t border-border-default' : ''
                }`}
              >
                <ProviderMark provider={provider} size={26} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm text-fg-primary">{agent.name}</span>
                  <span className="text-[11px] text-fg-muted">
                    Connect a {provider.company} account to choose its settings
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => onConnect(agent.id)}
                  className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-1 rounded-md border-none bg-transparent px-2 text-xs font-semibold text-accent hover:bg-accent-tint"
                >
                  <Plus size={14} aria-hidden="true" />
                  Connect
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
