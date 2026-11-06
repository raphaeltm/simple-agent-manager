/**
 * One profile in the list. From `md` up it is a table row (Profile · Runs ·
 * Requests · Usage · actions); below that the same DOM stacks into three
 * lines — name, what it runs, then resources and usage — via `md:contents`.
 */
import type { AgentProfile } from '@simple-agent-manager/shared';
import { getAgentDefinition, isValidAgentType } from '@simple-agent-manager/shared';
import { DropdownMenu } from '@simple-agent-manager/ui';
import { Cpu, Lock, Pencil, Trash2, Zap } from 'lucide-react';

import { ProviderMark } from '../accounts/AccountBits';
import { getAccountProvider } from '../accounts/provider-meta';
import { profileFacts, profileResources } from './profile-row-summary';
import { ProfileUsageStrip } from './ProfileUsageStrip';
import type { ProfileBudget } from './useProfileBudgets';

/** Column template shared by the header and every row, so they stay aligned. */
export const PROFILE_ROW_GRID =
  'md:grid md:grid-cols-[minmax(0,1.15fr)_minmax(0,1.35fr)_minmax(0,0.95fr)_minmax(0,1.55fr)_auto] md:items-center md:gap-x-4';

function agentName(agentType: string): string {
  return isValidAgentType(agentType)
    ? (getAgentDefinition(agentType)?.name ?? agentType)
    : agentType;
}

function ResourceLine({ profile }: Readonly<{ profile: AgentProfile }>) {
  const resources = profileResources(profile);
  const base = 'inline-flex min-w-0 flex-wrap items-center gap-x-1 text-[11px] text-fg-muted';
  if (resources.kind === 'instant') {
    return (
      <span className={base}>
        <Zap size={11} aria-hidden="true" className="shrink-0" />
        Instant container
      </span>
    );
  }
  if (resources.kind === 'default') {
    return (
      <span className={`${base} opacity-75`} title="Uses the project or installation default">
        <Cpu size={11} aria-hidden="true" className="shrink-0" />
        Default resources
      </span>
    );
  }
  return (
    <span className={base} title={resources.kind === 'request' ? resources.detail : undefined}>
      <Cpu size={11} aria-hidden="true" className="shrink-0" />
      <span className="whitespace-nowrap tabular-nums text-fg-primary">{resources.text}</span>
      {resources.kind === 'request' && resources.exclusiveNode && (
        <span className="inline-flex items-center gap-0.5 whitespace-nowrap text-warning-fg">
          <Lock size={10} aria-hidden="true" />
          own node
        </span>
      )}
    </span>
  );
}

export function ProfileRow({
  profile,
  budget,
  onEdit,
  onDelete,
}: Readonly<{
  profile: AgentProfile;
  budget: ProfileBudget | undefined;
  onEdit: () => void;
  onDelete: () => void;
}>) {
  const agent = agentName(profile.agentType);
  return (
    <div
      className={`flex min-w-0 items-start gap-2 py-2.5 pl-3 pr-1.5 ${PROFILE_ROW_GRID}`}
      data-testid="profile-row"
    >
      <div className="min-w-0 flex-1 md:contents">
        <div className="flex min-w-0 items-center gap-2.5">
          <span title={agent} className="inline-flex shrink-0">
            <ProviderMark provider={getAccountProvider('agent', profile.agentType)} size={22} />
          </span>
          <button
            type="button"
            onClick={onEdit}
            className="min-w-0 cursor-pointer border-0 bg-transparent p-0 text-left text-sm font-medium text-fg-primary line-clamp-2 [overflow-wrap:anywhere] hover:underline focus-visible:outline-2 focus-visible:outline-focus-ring"
            title={profile.description ?? profile.name}
          >
            {profile.name}
          </button>
          {profile.isBuiltin && (
            <span className="shrink-0 rounded border border-[rgba(34,197,94,0.15)] bg-[rgba(34,197,94,0.08)] px-1.5 py-0.5 text-[10px] font-medium text-accent">
              built-in
            </span>
          )}
        </div>

        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-8 text-xs text-fg-muted md:mt-0 md:pl-0">
          <span className="sr-only">{agent}</span>
          <span className="min-w-0 max-w-full truncate rounded-sm bg-inset px-1.5 py-0.5 font-mono text-[11px] text-fg-primary">
            {profile.model ?? `${agent} default model`}
          </span>
          {profileFacts(profile).map((fact) => (
            <span key={fact} className="whitespace-nowrap">
              {fact}
            </span>
          ))}
        </div>

        <div className="mt-1.5 flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 pl-8 md:contents">
          <div className="min-w-0">
            <ResourceLine profile={profile} />
          </div>
          <div className="min-w-0">
            <ProfileUsageStrip budget={budget} profileName={profile.name} />
          </div>
        </div>
      </div>

      <div className="shrink-0">
        <DropdownMenu
          aria-label={`Actions for ${profile.name}`}
          items={[
            {
              id: 'edit',
              label: 'Edit',
              icon: <Pencil size={14} aria-hidden="true" />,
              onClick: onEdit,
            },
            {
              id: 'delete',
              label: 'Delete',
              icon: <Trash2 size={14} aria-hidden="true" />,
              variant: 'danger',
              onClick: onDelete,
            },
          ]}
        />
      </div>
    </div>
  );
}
