import { AccountsSection } from '../components/accounts/AccountsSection';
import { AgentDefaultsSection } from '../components/accounts/AgentDefaultsSection';
import { ConnectAccountSheet } from '../components/accounts/ConnectAccountSheet';
import { legacyAgentKind } from '../components/accounts/provider-meta';
import { useConnectSheetState } from '../components/accounts/useConnectSheetState';
import { useAccountsData } from '../hooks/useAccounts';

/**
 * Settings → Agents: every agent account you've connected (and where each is
 * used), then each agent's settings — which never depend on the account.
 */
export function SettingsAgents() {
  const { model, projects, projectsTruncated, isLoading, error, retry } = useAccountsData();
  const sheet = useConnectSheetState();
  const groups = model?.agents ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <AccountsSection
        title="Agent accounts"
        description="The accounts your agents run on, and which projects use each one. Connect a work account, a personal one, or a client’s, and pin projects to the right one."
        groups={groups}
        projects={projects}
        projectsTruncated={projectsTruncated}
        unlinkedCredentialCount={model?.unlinkedCredentialCount ?? 0}
        isLoading={isLoading}
        error={error}
        onRetry={retry}
        onConnect={(providerId) => sheet.open(providerId)}
        onReplace={(account) =>
          sheet.open(account.target, legacyAgentKind(account.credentialKind) ?? undefined)
        }
      />

      <section aria-labelledby="agent-defaults-title" className="flex min-w-0 flex-col gap-3">
        <div className="max-w-2xl">
          <h2 id="agent-defaults-title" className="m-0 text-lg font-semibold text-fg-primary">
            Agent settings
          </h2>
          <p className="m-0 mt-1 text-sm text-fg-muted">
            How each agent behaves, whichever account a project runs on.
          </p>
        </div>
        <AgentDefaultsSection groups={groups} onConnect={(agentId) => sheet.open(agentId)} />
      </section>

      {sheet.isOpen && model && (
        <ConnectAccountSheet
          kind="agent"
          providerId={sheet.providerId}
          initialAuthMethod={sheet.authMethod}
          groups={groups ?? []}
          onClose={sheet.close}
        />
      )}
    </div>
  );
}
