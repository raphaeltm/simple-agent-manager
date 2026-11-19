/**
 * Project settings → Accounts. A project either follows your default account
 * for a provider or pins an account of its own. Accounts always belong to you;
 * the machines a project runs on come from its node pool (Infrastructure tab).
 */
import { Alert, Skeleton } from '@simple-agent-manager/ui';
import { Cloud, Plus } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router';

import { useAccountsData } from '../../hooks/useAccounts';
import { isProviderInUse, type ProviderAccounts } from './account-model';
import { ProviderMark } from './AccountBits';
import { ConnectAccountSheet } from './ConnectAccountSheet';
import { ProjectAccountRow } from './ProjectAccountRow';
import { useConnectSheetState } from './useConnectSheetState';

const CLOUD_PREFIX = 'cloud:';

export interface ProjectAccountsSectionProps {
  projectId: string;
  projectName: string;
}

export function ProjectAccountsSection({
  projectId,
  projectName,
}: Readonly<ProjectAccountsSectionProps>) {
  const project = useMemo(() => ({ id: projectId, name: projectName }), [projectId, projectName]);
  const { model, projects, isLoading, error, retry } = useAccountsData({ project });
  const sheet = useConnectSheetState();
  const projectNames = useMemo(
    () => new Map(projects.map((item) => [item.id, item.name])),
    [projects]
  );

  // One URL param serves both kinds; cloud providers are prefixed so an agent
  // and a cloud with the same id can never collide.
  const sheetKind = sheet.providerId?.startsWith(CLOUD_PREFIX) ? 'compute' : 'agent';
  const sheetProvider = sheet.providerId?.replace(CLOUD_PREFIX, '');

  const agentGroups = model?.agents ?? [];
  const inUseAgents = agentGroups.filter(isProviderInUse);
  const idleAgents = agentGroups.filter((group) => !isProviderInUse(group));
  const pinnedClouds = (model?.clouds ?? []).filter((group) => {
    const resolution = group.resolutions.get(projectId);
    return resolution?.source === 'pinned' || resolution?.source === 'blocked';
  });

  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="project-accounts-section">
      <section aria-labelledby="project-agent-accounts" className="flex min-w-0 flex-col gap-3">
        <div className="max-w-2xl">
          <h2 id="project-agent-accounts" className="m-0 text-lg font-semibold text-fg-primary">
            Agent accounts
          </h2>
          <p className="m-0 mt-1 text-sm text-fg-muted">
            {projectName} uses your default account for each agent unless you pin one here — for
            example when a client pays for this project.
          </p>
        </div>

        {isLoading && !model && (
          <Skeleton width="100%" height="9rem" borderRadius="var(--sam-radius-lg)" />
        )}
        {error && !model && (
          <Alert variant="error">
            {error}
            <button
              type="button"
              onClick={retry}
              className="ml-2 cursor-pointer border-none bg-transparent text-[length:inherit] text-inherit underline"
            >
              Retry
            </button>
          </Alert>
        )}

        {model && (
          <div className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border-default bg-surface">
            {inUseAgents.map((group, index) => (
              <ProjectAccountRow
                key={group.provider.id}
                group={group}
                projectId={projectId}
                projectName={projectName}
                projectNames={projectNames}
                first={index === 0}
                onUseDifferent={(providerId) => sheet.open(providerId)}
              />
            ))}
            {idleAgents.length > 0 && (
              <NotConnectedRow
                groups={idleAgents}
                bordered={inUseAgents.length > 0}
                onConnect={(providerId) => sheet.open(providerId)}
              />
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="project-compute" className="flex min-w-0 flex-col gap-3">
        <div className="max-w-2xl">
          <h2 id="project-compute" className="m-0 text-lg font-semibold text-fg-primary">
            Compute
          </h2>
          <p className="m-0 mt-1 text-sm text-fg-muted">
            Machines for {projectName} come from its node pool, built from cloud accounts.{' '}
            <Link to={`/projects/${projectId}/settings/infrastructure`} className="text-accent">
              Open Infrastructure
            </Link>
          </p>
        </div>
        {pinnedClouds.length > 0 && (
          <div className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border-default bg-surface">
            {pinnedClouds.map((group, index) => (
              <ProjectAccountRow
                key={group.provider.id}
                group={group}
                projectId={projectId}
                projectName={projectName}
                projectNames={projectNames}
                first={index === 0}
                onUseDifferent={(providerId) => sheet.open(`${CLOUD_PREFIX}${providerId}`)}
              />
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => sheet.open(`${CLOUD_PREFIX}any`)}
          className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 self-start rounded-md border border-dashed border-border-default bg-transparent px-3 text-xs font-semibold text-accent hover:border-accent"
        >
          <Cloud size={14} aria-hidden="true" />
          Use a cloud account only this project bills to
        </button>
      </section>

      {sheet.isOpen && model && (
        <ConnectAccountSheet
          kind={sheetKind}
          providerId={sheetProvider === 'any' ? undefined : sheetProvider}
          initialAuthMethod={sheet.authMethod}
          projectId={projectId}
          projectName={projectName}
          groups={sheetKind === 'compute' ? model.clouds : model.agents}
          onClose={sheet.close}
        />
      )}
    </div>
  );
}

function NotConnectedRow({
  groups,
  bordered,
  onConnect,
}: Readonly<{ groups: ProviderAccounts[]; bordered: boolean; onConnect: (id: string) => void }>) {
  return (
    <div
      className={`flex flex-wrap items-center gap-2 px-4 py-3 ${bordered ? 'border-t border-border-default' : ''}`}
    >
      <span className="text-xs text-fg-muted">Not connected:</span>
      {groups.map((group) => (
        <button
          key={group.provider.id}
          type="button"
          onClick={() => onConnect(group.provider.id)}
          className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border border-dashed border-border-default bg-transparent py-0.5 pl-1 pr-3 text-xs text-fg-muted hover:border-accent hover:text-fg-primary"
        >
          <ProviderMark provider={group.provider} size={22} />
          {group.provider.name}
          <Plus size={12} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
