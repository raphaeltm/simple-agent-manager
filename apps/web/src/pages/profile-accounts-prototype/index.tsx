/**
 * PROTOTYPE — attaching agent accounts to profiles, in single-person and shared
 * projects. Mock data only; no API calls. Must be removed before merging to main.
 */
import { useState } from 'react';

import { MY_CHOICES, type PersonalChoices, type Profile, TEAM_ACCOUNTS, TEAM_PROFILES, type TeamAccount } from './mock-data';
import { Panel, PrivateTag, TeamTag } from './parts';
import { ShareScreen } from './ShareScreen';
import { SoloScreen } from './SoloScreen';
import { TeamScreen } from './TeamScreen';

type TabId = 'solo' | 'team' | 'share' | 'rules';

const TABS: { id: TabId; label: string }[] = [
  { id: 'solo', label: 'Just you' },
  { id: 'team', label: 'Shared project' },
  { id: 'share', label: 'Share an account' },
  { id: 'rules', label: 'How it’s chosen' },
];

export function ProfileAccountsPrototype() {
  const [tab, setTab] = useState<TabId>('solo');
  const [choices, setChoices] = useState<PersonalChoices>(MY_CHOICES);
  const [teamProfiles, setTeamProfiles] = useState<Profile[]>(TEAM_PROFILES);
  const [teamAccounts, setTeamAccounts] = useState<TeamAccount[]>(TEAM_ACCOUNTS);
  const [role, setRole] = useState<'admin' | 'maintainer'>('admin');

  return (
    <div style={{ height: '100vh', overflow: 'auto' }} className="bg-canvas text-fg-primary">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-3 py-4 sm:px-6 sm:py-6">
        <header className="flex min-w-0 flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-warning-fg">Prototype · mock data</span>
          <h1 className="m-0 text-lg font-semibold sm:text-xl">Agent accounts on profiles</h1>
          <p className="m-0 max-w-3xl text-[13px] text-fg-muted">
            Pick which account a profile runs on. In a shared project each person picks their own, and admins can
            put a team account on a profile instead.
          </p>
        </header>

        <nav
          aria-label="Prototype scenarios"
          className="-mx-3 flex gap-1 overflow-x-auto border-b border-border-default px-3 sm:mx-0 sm:px-0"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={tab === t.id ? 'page' : undefined}
              className={`min-h-11 shrink-0 whitespace-nowrap border-b-2 px-3 text-[13px] font-semibold ${
                tab === t.id ? 'border-accent text-fg-primary' : 'border-transparent text-fg-muted'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {tab === 'solo' && <SoloScreen choices={choices} setChoices={setChoices} />}
        {tab === 'team' && (
          <TeamScreen
            role={role}
            setRole={setRole}
            choices={choices}
            setChoices={setChoices}
            profiles={teamProfiles}
            setProfiles={setTeamProfiles}
            teamAccounts={teamAccounts}
            onGoShare={() => setTab('share')}
          />
        )}
        {tab === 'share' && (
          <ShareScreen
            teamAccounts={teamAccounts}
            setTeamAccounts={setTeamAccounts}
            profiles={teamProfiles}
            setProfiles={setTeamProfiles}
          />
        )}
        {tab === 'rules' && <Rules />}
      </div>
    </div>
  );
}

function Rules() {
  const tiers = [
    ['Your account for this profile', 'New. Private to you. Skipped when an admin requires the team account.', 'private'],
    ['Team account on this profile', 'New. Set by admins/owners. Reached through SAM’s proxy, so the key never enters a workspace.', 'team'],
    ['Your account for this project', 'Exists today (project pin). Private to you.', 'private'],
    ['Your default account', 'Exists today. Private to you.', 'private'],
    ['SAM platform AI', 'Exists today, where the installation offers it.', ''],
  ] as const;
  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-2">
      <Panel title="Order SAM checks, most specific first">
        <ol className="m-0 flex flex-col gap-2 pl-5 text-[13px]">
          {tiers.map(([title, detail, kind]) => (
            <li key={title}>
              <span className="flex flex-wrap items-center gap-2 font-medium">
                {title} {kind === 'private' && <PrivateTag />} {kind === 'team' && <TeamTag />}
              </span>
              <span className="block text-xs text-fg-muted">{detail}</span>
            </li>
          ))}
        </ol>
      </Panel>
      <Panel title="Rules that keep it predictable">
        <ul className="m-0 flex flex-col gap-2 pl-5 text-[13px] text-fg-secondary">
          <li><strong>Stop, don’t switch.</strong> A paused pin or a removed team account stops the run with a clear reason. SAM never quietly bills a different account.</li>
          <li><strong>Pins follow the agent that actually runs.</strong> If a skill switches a Claude profile to OpenCode, the Claude pin is skipped.</li>
          <li><strong>Choices are per person.</strong> Your pins never apply to anyone else, and nobody sees which account you chose.</li>
          <li><strong>Only shareable accounts can be shared.</strong> API keys and OpenAI-compatible endpoints, through the proxy. Subscription sign-ins stay personal.</li>
          <li><strong>Leaving cleans up.</strong> A member who leaves loses their pins on the project’s profiles, and accounts they shared are removed.</li>
          <li><strong>No account means no workspace.</strong> SAM checks before creating one, so a run that can’t authenticate doesn’t cost a VM.</li>
          <li><strong>Everything is recorded.</strong> Each session records which account it used, which layer chose it, and who started it.</li>
        </ul>
      </Panel>
    </div>
  );
}
