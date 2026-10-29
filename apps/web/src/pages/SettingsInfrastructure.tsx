import { AccountsSection } from '../components/accounts/AccountsSection';
import { ConnectAccountSheet } from '../components/accounts/ConnectAccountSheet';
import { useConnectSheetState } from '../components/accounts/useConnectSheetState';
import { DefaultCapacityPoolsPanel } from '../components/project-settings/DefaultCapacityPoolsPanel';
import { useAccountsData } from '../hooks/useAccounts';

/**
 * Settings → Infrastructure: the cloud accounts you own, then the node pool
 * that decides which of their machines new workspaces may use. Accounts always
 * belong to you; a project can run its own node pool so collaborators share it.
 */
export function SettingsInfrastructure() {
  const { model, projects, projectsTruncated, isLoading, error, retry } = useAccountsData();
  const sheet = useConnectSheetState();
  const groups = model?.clouds ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <AccountsSection
        title="Cloud accounts"
        description="The cloud accounts SAM can start machines in, and which projects bill to each one."
        groups={groups}
        projects={projects}
        projectsTruncated={projectsTruncated}
        unlinkedCredentialCount={model?.unlinkedCredentialCount ?? 0}
        isLoading={isLoading}
        error={error}
        onRetry={retry}
        onConnect={(providerId) => sheet.open(providerId)}
        onReplace={(account) => sheet.open(account.target)}
      />

      <section aria-labelledby="node-pool-title" className="flex min-w-0 flex-col gap-3">
        <div className="max-w-2xl">
          <h2 id="node-pool-title" className="m-0 text-lg font-semibold text-fg-primary">
            Node pool
          </h2>
          <p className="m-0 mt-1 text-sm text-fg-muted">
            Which machine types and regions from your cloud accounts new workspaces may use. A
            project can set up its own pool for everyone working in it.
          </p>
        </div>
        <DefaultCapacityPoolsPanel scope="user" />
      </section>

      {sheet.isOpen && model && (
        <ConnectAccountSheet
          kind="compute"
          providerId={sheet.providerId}
          groups={groups ?? []}
          onClose={sheet.close}
        />
      )}
    </div>
  );
}
