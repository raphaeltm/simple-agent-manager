import type {
  AgentCredentialInfo,
  AgentInfo,
  AgentSettingsResponse,
  AgentType,
  CredentialKind,
  OpenCodeProvider,
  SaveAgentCredentialRequest,
  SaveAgentSettingsRequest,
} from '@simple-agent-manager/shared';
import { StatusBadge } from '@simple-agent-manager/ui';

import { getAgentConnectionSummary } from '../lib/agent-status';
import { AgentKeyCard } from './AgentKeyCard';
import { AgentSettingsCard } from './AgentSettingsCard';

export interface AgentCardProps {
  agent: AgentInfo;
  credentials: AgentCredentialInfo[] | null;
  settings: AgentSettingsResponse | null;
  onSaveCredential: (request: SaveAgentCredentialRequest) => Promise<void>;
  onDeleteCredential: (agentType: AgentType, credentialKind: CredentialKind) => Promise<void>;
  onSaveSettings: (agentType: AgentType, data: SaveAgentSettingsRequest) => Promise<void>;
  onResetSettings: (agentType: AgentType) => Promise<void>;
}

/**
 * Unified per-agent card combining connection (credentials) and configuration
 * (model, permission mode, OpenCode provider) in a single panel. Replaces the
 * split Agent Keys / Agent Config surfaces at user scope.
 *
 * The OpenCode provider selected in Configuration drives the credential form's
 * key label, so both subsections must share state. We read the selection from
 * `settings` directly rather than plumbing it through a ref.
 */
export function AgentCard({
  agent,
  credentials,
  settings,
  onSaveCredential,
  onDeleteCredential,
  onSaveSettings,
  onResetSettings,
}: AgentCardProps) {
  const opencodeProvider = (settings?.opencodeProvider as OpenCodeProvider | null | undefined) ?? null;
  const summary = getAgentConnectionSummary(agent, credentials, opencodeProvider, 'user');

  return (
    <div
      className="border border-border-default rounded-md p-4 flex flex-col gap-4"
      data-testid={`agent-card-${agent.id}`}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex flex-col gap-1 min-w-0">
          <h3 className="text-base font-semibold text-fg-primary">{agent.name}</h3>
          <p className="text-xs text-fg-muted">{agent.description}</p>
        </div>
        <StatusBadge status={summary.status} label={summary.label} />
      </div>

      <section
        aria-labelledby={`agent-connection-${agent.id}`}
        className="flex flex-col gap-3 pt-4 border-t border-border-default"
      >
        <h4
          id={`agent-connection-${agent.id}`}
          className="text-xs font-semibold uppercase tracking-wide text-fg-muted"
        >
          Connection
        </h4>
        <AgentKeyCard
          agent={agent}
          credentials={credentials}
          onSave={onSaveCredential}
          onDelete={onDeleteCredential}
          opencodeProvider={opencodeProvider}
          scope="user"
          embedded
        />
      </section>

      <section
        aria-labelledby={`agent-configuration-${agent.id}`}
        className="flex flex-col gap-3 pt-4 border-t border-border-default"
      >
        <h4
          id={`agent-configuration-${agent.id}`}
          className="text-xs font-semibold uppercase tracking-wide text-fg-muted"
        >
          Configuration
        </h4>
        <AgentSettingsCard
          agent={agent}
          settings={settings}
          onSave={onSaveSettings}
          onReset={onResetSettings}
          embedded
        />
      </section>
    </div>
  );
}
