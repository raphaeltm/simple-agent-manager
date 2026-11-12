/**
 * Session details: the configuration the agent actually runs with — model, effort,
 * permission mode, skill and (for OpenCode) inference provider. These come from the
 * session's frozen runtime contract, after profile, skill, project default and user
 * settings were applied, so overrides are already resolved. Shares the run-details
 * query with `SessionRunDetails`, so opening the panel costs one request.
 */
import {
  AGENT_PERMISSION_MODE_LABELS,
  type AgentEffort,
  type AgentPermissionMode,
  getModelsForAgent,
  getSupportedEffortsForAgent,
  OPENCODE_PROVIDERS,
  type OpenCodeProvider,
  type SessionAgentRuntimeConfig,
} from '@simple-agent-manager/shared';
import { useQuery } from '@tanstack/react-query';
import { SlidersHorizontal } from 'lucide-react';

import { useQueryScope } from '../../hooks/useQueryScope';
import { sessionAgentCredentialQueryOptions } from '../../lib/query-options';
import { EFFORT_LABELS } from '../agent-profiles/profile-form-options';
import { modelLabel } from '../project-chat/profile-picker/model';
import { SessionDetailSection } from './SessionDetailSection';

export function SessionRunConfiguration({
  projectId,
  sessionId,
}: Readonly<{ projectId: string; sessionId: string }>) {
  const queryScope = useQueryScope();
  const query = useQuery({
    ...sessionAgentCredentialQueryOptions(queryScope, projectId, sessionId),
    enabled: Boolean(queryScope),
  });
  const runtime = query.data?.runtime;

  // A failed load is shown, so it is not mistaken for a session with no configuration.
  if (!runtime && query.isError) {
    return (
      <SessionDetailSection icon={<SlidersHorizontal size={12} />} label="Configuration">
        <div
          role="alert"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted"
        >
          <span>Couldn’t load this session’s configuration.</span>
          <button
            type="button"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            className="rounded-md bg-transparent px-1 font-medium text-accent hover:underline disabled:opacity-60"
          >
            {query.isFetching ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      </SessionDetailSection>
    );
  }
  if (!runtime) return null;
  const rows = configurationRows(runtime);
  return (
    <SessionDetailSection icon={<SlidersHorizontal size={12} />} label="Configuration">
      <dl
        data-testid="session-run-configuration"
        className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs"
      >
        {rows.map(({ label, value, detail }) => (
          <div key={label} className="contents">
            <dt className="text-fg-muted">{label}</dt>
            <dd className="m-0 min-w-0 text-fg-primary [overflow-wrap:anywhere]">
              {value}
              {detail && (
                <span className="ml-1.5 font-mono text-[11px] text-fg-muted">{detail}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </SessionDetailSection>
  );
}

interface ConfigurationRow {
  label: string;
  value: string;
  /** The raw identifier, shown beside a friendly label when they differ. */
  detail?: string;
}

function configurationRows(runtime: SessionAgentRuntimeConfig): ConfigurationRow[] {
  const rows: ConfigurationRow[] = [];
  // A catalogued model gets its friendly name with the raw id beside it; anything else
  // (custom or OpenCode ids) is shown verbatim, since a friendly guess would only repeat it.
  const catalogued =
    runtime.model &&
    getModelsForAgent(runtime.agentType).some((model) => model.id === runtime.model);
  if (!runtime.model) rows.push({ label: 'Model', value: 'Agent default' });
  else if (catalogued)
    rows.push({
      label: 'Model',
      value: modelLabel({ agentType: runtime.agentType, model: runtime.model }) ?? runtime.model,
      detail: runtime.model,
    });
  else rows.push({ label: 'Model', value: runtime.model });
  // Effort is only meaningful for agents that accept more than "auto".
  if (getSupportedEffortsForAgent(runtime.agentType).length > 1 || isExplicitEffort(runtime)) {
    rows.push({
      label: 'Effort',
      value: runtime.effort
        ? (EFFORT_LABELS[runtime.effort as AgentEffort] ?? runtime.effort)
        : EFFORT_LABELS.auto,
    });
  }
  rows.push({ label: 'Permissions', value: permissionsLabel(runtime) });
  if (runtime.opencodeProvider) {
    rows.push({
      label: 'Provider',
      value:
        OPENCODE_PROVIDERS[runtime.opencodeProvider as OpenCodeProvider]?.label ??
        runtime.opencodeProvider,
    });
  }
  if (runtime.skillName) rows.push({ label: 'Skill', value: runtime.skillName });
  return rows;
}

function isExplicitEffort(runtime: SessionAgentRuntimeConfig): boolean {
  return Boolean(runtime.effort && runtime.effort !== 'auto');
}

/**
 * Codex ignores the permission mode: the VM agent always starts it with
 * `approval_policy = "never"` and full sandbox access (`codex_config.go`,
 * `buildCodexACPManagedConfigEnv`) and skips `SetSessionMode` for it. Showing the stored
 * mode there would misstate what is running.
 */
function permissionsLabel(runtime: SessionAgentRuntimeConfig): string {
  if (runtime.agentType === 'openai-codex') return 'Full access (Codex never asks)';
  return (
    AGENT_PERMISSION_MODE_LABELS[runtime.permissionMode as AgentPermissionMode] ??
    runtime.permissionMode
  );
}
