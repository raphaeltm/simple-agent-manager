/**
 * The profile editor's "Account" section: which of MY accounts this profile runs
 * on when I use it. The choice is private and saves as soon as it is picked,
 * independently of the profile's other fields (pinning needs only permission to
 * run tasks, not to edit the profile).
 */
import type { AgentProfile, AgentSkill } from '@simple-agent-manager/shared';
import { Lock } from 'lucide-react';
import { useId, useState } from 'react';
import { Link } from 'react-router';

import type { AccountView } from './account-model';
import { outcomeLabel, type ProfileAccountExplanation } from './profile-account-resolution';
import { getAccountProvider } from './provider-meta';
import { ResolutionBreakdown } from './ResolutionBreakdown';
import type { ProfileAccountState } from './useProfileAccount';

export interface ProfileAccountSectionProps {
  profile: Pick<AgentProfile, 'id' | 'agentType' | 'projectId'>;
  state: ProfileAccountState;
  /** More than one person can run this profile, so say the choice is private. */
  sharedProject: boolean;
  /** Project skills; ones that switch agent make the choice not apply to their runs. */
  skills: AgentSkill[];
}

export function ProfileAccountSection({
  profile,
  state,
  sharedProject,
  skills,
}: Readonly<ProfileAccountSectionProps>) {
  const name = useId();
  const agent = getAccountProvider('agent', profile.agentType).name;
  const { group, explanation } = state;

  if (state.isLoading && !explanation) {
    return <p className="m-0 text-xs text-fg-muted">Loading your accounts…</p>;
  }
  if (!group || !explanation) {
    return (
      <p className="m-0 text-xs text-fg-muted">
        {state.error ?? `Your ${agent} accounts are unavailable right now.`}
      </p>
    );
  }

  const pinnedId = explanation.pin?.configurationId ?? null;
  const switching = skills.filter(
    (skill) => skill.agentType !== null && skill.agentType !== profile.agentType
  );

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="profile-account-section">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <p className="m-0 min-w-0 flex-1 text-xs text-fg-muted">
          Which {agent} account this profile runs on when you use it.
          {profile.projectId === null
            ? ' This profile is yours, so the choice applies in every project.'
            : ''}
        </p>
        {sharedProject && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border-default px-2 py-0.5 text-[11px] text-fg-muted">
            <Lock size={11} aria-hidden="true" />
            Only you see this
          </span>
        )}
      </div>

      <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-none p-0" disabled={state.saving}>
        <legend className="sr-only">Account for this profile</legend>
        <AccountOption
          name={name}
          checked={pinnedId === null}
          label="Use my usual account"
          hint={`Right now: ${outcomeLabel(explanation.usual)}`}
          onSelect={() => void state.choose(null)}
        />
        {group.accounts.map((account) => (
          <AccountOption
            key={account.id}
            name={name}
            checked={pinnedId === account.configurationId}
            label={account.label}
            hint={accountHint(account)}
            // A paused account would stop the run; it stays visible (and selected
            // when it is the current pin) but cannot be newly chosen.
            disabled={!account.active && pinnedId !== account.configurationId}
            onSelect={() => void state.choose(account)}
          />
        ))}
        {group.accounts.length === 0 && (
          <p className="m-0 px-1 text-xs text-fg-muted">
            You have no {agent} accounts yet.{' '}
            <Link to="/settings/agents" className="text-accent-primary">
              Connect one in Settings → Agents
            </Link>
          </p>
        )}
      </fieldset>

      {sharedProject && (
        <p className="m-0 text-[11px] text-fg-muted">
          Other members pick their own account for this profile. Yours never runs their work.
        </p>
      )}
      {switching.length > 0 && (
        <p className="m-0 text-[11px] text-warning-fg [overflow-wrap:anywhere]">
          {switchingSkillsWarning(switching, agent)}
        </p>
      )}

      <RunsOn explanation={explanation} agent={agent} />
    </div>
  );
}

function accountHint(account: AccountView): string | undefined {
  if (!account.active) return 'Paused — turn it back on in Settings → Agents';
  if (account.role === 'default') return 'Your default';
  return undefined;
}

function switchingSkillsWarning(skills: AgentSkill[], agent: string): string {
  const names = skills.map((skill) => skill.name);
  const shown = names.slice(0, 3).join(', ');
  const more = names.length > 3 ? ` and ${names.length - 3} more` : '';
  const verb = names.length === 1 ? 'switches' : 'switch';
  return `${shown}${more} ${verb} the agent, so runs started with ${names.length === 1 ? 'it' : 'them'} don’t use this ${agent} choice.`;
}

function AccountOption({
  name,
  checked,
  label,
  hint,
  disabled,
  onSelect,
}: Readonly<{
  name: string;
  checked: boolean;
  label: string;
  hint?: string;
  disabled?: boolean;
  onSelect: () => void;
}>) {
  return (
    <label
      className={`flex min-h-11 min-w-0 items-center gap-2.5 rounded-md border px-3 py-2 ${
        checked ? 'border-accent-primary bg-accent-tint' : 'border-border-default'
      } ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-surface-hover'}`}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        className="h-3.5 w-3.5 shrink-0 accent-[var(--sam-color-focus-ring)]"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-fg-primary" title={label}>
          {label}
        </span>
        {hint && <span className="text-[11px] text-fg-muted [overflow-wrap:anywhere]">{hint}</span>}
      </span>
    </label>
  );
}

/** One line answering "which account will run", with the full breakdown behind a disclosure. */
function RunsOn({
  explanation,
  agent,
}: Readonly<{ explanation: ProfileAccountExplanation; agent: string }>) {
  const [open, setOpen] = useState(explanation.needsAttention);
  const { outcome } = explanation;
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md border border-border-default p-2.5">
      <p
        className={`m-0 text-xs [overflow-wrap:anywhere] ${
          outcome.kind === 'halted' || outcome.kind === 'none'
            ? 'text-danger-fg'
            : 'text-fg-primary'
        }`}
        data-testid="profile-account-outcome"
      >
        {outcomeSentence(explanation, agent)}
      </p>
      <details
        open={open}
        onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer text-[11px] text-fg-muted">
          How SAM picks the account
        </summary>
        <div className="mt-2">
          <ResolutionBreakdown explanation={explanation} />
        </div>
      </details>
    </div>
  );
}

export function outcomeSentence(explanation: ProfileAccountExplanation, agent: string): string {
  const { outcome } = explanation;
  switch (outcome.kind) {
    case 'account':
      return `Runs ${agent} on ${outcome.account.label}.`;
    case 'platform':
      return `Runs ${agent} on SAM’s platform account.`;
    case 'halted':
      return outcome.tier === 'profile'
        ? 'Stops: the account chosen for this profile is paused. SAM won’t switch to another account.'
        : 'Stops: your account for this project is paused. SAM won’t switch to another account.';
    case 'none':
      return `No ${agent} account. Runs with this profile can’t start until you connect one.`;
  }
}
