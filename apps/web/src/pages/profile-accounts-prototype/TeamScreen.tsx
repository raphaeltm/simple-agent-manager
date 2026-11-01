import { useState } from 'react';

import {
  ACCOUNTS,
  AGENT_LABEL,
  ME,
  MEMBERS,
  must,
  OTHER_MEMBER_CHOICES,
  type PersonalChoices,
  type Profile,
  TEAM_PROJECT,
  type TeamAccount,
} from './mock-data';
import {
  accountOptions,
  AccountPicker,
  AgentMark,
  Callout,
  Ladder,
  OutcomeLine,
  Panel,
  PrivateTag,
  Tag,
  TeamTag,
  Toggle,
} from './parts';
import { type Outcome, resolveAccount, type TierId } from './resolve';
import { ProfileList } from './SoloScreen';

const INHERIT = '__inherit__';
const OWN = '__own__';

const TIER_WORD: Record<TierId, string> = {
  profile: 'Their own account for this profile',
  team: 'Team account',
  project: 'Their own account for this project',
  default: 'Their default account',
  platform: 'SAM platform AI',
};

export function TeamScreen({ role, setRole, choices, setChoices, profiles, setProfiles, teamAccounts, onGoShare }: Readonly<{
  role: 'admin' | 'maintainer';
  setRole: (role: 'admin' | 'maintainer') => void;
  choices: PersonalChoices;
  setChoices: (next: PersonalChoices) => void;
  profiles: Profile[];
  setProfiles: (next: Profile[]) => void;
  teamAccounts: TeamAccount[];
  onGoShare: () => void;
}>) {
  const [selectedId, setSelectedId] = useState(must(profiles[2], 'a team profile').id);
  const profile = must(profiles.find((p) => p.id === selectedId), 'the selected profile');
  const isAdmin = role === 'admin';
  const team = teamAccounts.find((t) => t.id === profile.teamAccountId) ?? null;
  const personalLocked = Boolean(team && !profile.allowPersonal);

  const resolveFor = (p: Profile, c: PersonalChoices, hide = false) =>
    resolveAccount({ profile: p, projectId: TEAM_PROJECT.id, choices: c, accounts: ACCOUNTS, teamAccounts, includeTeamTier: true, hideAccountNames: hide });
  const mine = resolveFor(profile, choices);

  const updateProfile = (patch: Partial<Profile>) =>
    setProfiles(profiles.map((p) => (p.id === profile.id ? { ...p, ...patch } : p)));

  const myPin = choices.profilePins[profile.id];
  const setPin = (value: string) => {
    const profilePins = { ...choices.profilePins };
    if (value === INHERIT) delete profilePins[profile.id];
    else profilePins[profile.id] = value;
    setChoices({ ...choices, profilePins });
  };

  const withoutMyPin = resolveFor(profile, { ...choices, profilePins: {} });
  const inheritHint =
    withoutMyPin.outcome.kind === 'account'
      ? `Right now: ${withoutMyPin.outcome.label}`
      : withoutMyPin.outcome.kind === 'halt'
        ? 'Right now: stopped — see below'
        : 'Right now: no account';

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-xs text-fg-muted">Viewing {TEAM_PROJECT.name} as</span>
        {(['admin', 'maintainer'] as const).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setRole(r)}
            aria-pressed={role === r}
            className={`min-h-9 rounded-full border px-3 text-xs font-semibold ${
              role === r ? 'border-accent bg-accent-tint text-fg-primary' : 'border-border-default text-fg-muted'
            }`}
          >
            {r === 'admin' ? 'Admin / owner' : 'Maintainer'}
          </button>
        ))}
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <h2 className="m-0 text-xs font-semibold uppercase tracking-wide text-fg-muted">
            Profiles in {TEAM_PROJECT.name} · {MEMBERS.length} members
          </h2>
          <ProfileList
            profiles={profiles}
            selectedId={selectedId}
            onSelect={setSelectedId}
            badge={(p) => {
              const t = teamAccounts.find((x) => x.id === p.teamAccountId);
              const r = resolveFor(p, choices);
              return (
                <>
                  {t ? (
                    <Tag tone={t.status === 'revoked' ? 'danger' : 'info'}>
                      {t.status === 'revoked' ? 'Team account removed' : `Team: ${t.label}`}
                    </Tag>
                  ) : (
                    <Tag>Everyone’s own account</Tag>
                  )}
                  {r.outcome.kind === 'account' && r.outcome.tier === 'profile' && <Tag tone="accent">You: your pin</Tag>}
                </>
              );
            }}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <Panel
            title={
              <span className="flex min-w-0 items-center gap-2">
                <AgentMark agentType={profile.agentType} size={24} />
                <span className="truncate">{profile.name}</span>
              </span>
            }
            aside={<TeamTag />}
          >
            <h4 className="m-0 mb-1 text-[13px] font-semibold text-fg-primary">Who pays when this profile runs</h4>
            {isAdmin ? (
              <>
                <p className="m-0 mb-2 text-xs text-fg-muted">Applies to every member who runs this profile.</p>
                <AccountPicker
                  name={`team-${profile.id}`}
                  value={profile.teamAccountId ?? OWN}
                  onChange={(v) => updateProfile({ teamAccountId: v === OWN ? null : v })}
                  options={[
                    { value: OWN, label: 'Each member’s own account', hint: 'Members who have no account can’t run it' },
                    ...teamAccounts
                      .filter((t) => t.agentType === profile.agentType)
                      .map((t) => ({
                        value: t.id,
                        label: `Team account · ${t.label}`,
                        hint:
                          t.status === 'revoked'
                            ? `Removed — ${t.revokedNote}`
                            : `Shared by ${MEMBERS.find((m) => m.id === t.contributedBy)?.name} · ${t.usageThisMonth} this month`,
                        disabled: t.status === 'revoked' && profile.teamAccountId !== t.id,
                      })),
                  ]}
                />
                <button type="button" onClick={onGoShare} className="mt-2 min-h-9 text-xs font-semibold text-accent">
                  + Share one of your {AGENT_LABEL[profile.agentType]} accounts with the team
                </button>
                {team && (
                  <div className="mt-2 border-t border-border-default pt-2">
                    <Toggle
                      checked={profile.allowPersonal}
                      onChange={(v) => updateProfile({ allowPersonal: v })}
                      label="Members may use their own account instead"
                      hint={
                        profile.allowPersonal
                          ? 'A member who picks their own account for this profile uses it; everyone else uses the team account.'
                          : 'Everyone uses the team account, even members who picked their own.'
                      }
                    />
                  </div>
                )}
              </>
            ) : (
              <p className="m-0 text-[13px] text-fg-primary">
                {team ? (
                  <>
                    Team account <strong>{team.label}</strong>
                    {team.status === 'revoked' && <span className="text-danger-fg"> (removed)</span>}
                    {profile.allowPersonal ? ', unless you pick your own below.' : '. Admins require it for everyone.'}
                  </>
                ) : (
                  'Each member’s own account.'
                )}
                <span className="block text-xs text-fg-muted">Only admins and owners change this.</span>
              </p>
            )}
          </Panel>

          <Panel title="Your account for this profile" aside={<PrivateTag />}>
            <AccountPicker
              name={`mine-${profile.id}`}
              value={myPin && !personalLocked ? myPin : INHERIT}
              onChange={setPin}
              disabled={personalLocked}
              options={[
                {
                  value: INHERIT,
                  label: team ? 'Use the team account' : 'Use my usual account',
                  hint: inheritHint,
                },
                ...accountOptions(ACCOUNTS, profile.agentType),
              ]}
            />
            {personalLocked && (
              <p className="m-0 mt-2 text-xs text-fg-muted">
                An admin requires the team account for this profile.
                {myPin && ' Your earlier choice is kept and comes back if they allow personal accounts again.'}
              </p>
            )}
          </Panel>

          <Panel title="Which account runs when you use it">
            <div className="flex flex-col gap-3">
              <OutcomeLine outcome={mine.outcome} agentType={mine.runAgentType} />
              <Ladder resolution={mine} />
            </div>
          </Panel>

          {isAdmin && (
            <Panel title="Members" aside={<Tag>Account names stay private</Tag>}>
              <ul className="m-0 flex list-none flex-col divide-y divide-border-default p-0">
                {MEMBERS.map((m) => {
                  const c = m.id === ME ? choices : must(OTHER_MEMBER_CHOICES[m.id], `choices for ${m.id}`);
                  const r = resolveFor(profile, c, m.id !== ME);
                  return (
                    <li key={m.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2">
                      <span className="min-w-0 flex-1 basis-40">
                        <span className="block truncate text-[13px] text-fg-primary" title={m.name}>
                          {m.name}
                          {m.id === ME && <span className="text-fg-muted"> (you)</span>}
                        </span>
                        <span className="text-[11px] capitalize text-fg-muted">{m.role}</span>
                      </span>
                      <MemberStatus outcome={r.outcome} role={m.role} isMe={m.id === ME} />
                    </li>
                  );
                })}
              </ul>
            </Panel>
          )}

          <Callout>
            Personal pins are stored per person. Two members can pin different accounts to the same profile, and
            neither can see the other’s choice. When someone leaves the project, their pins on its profiles are
            removed, and any account they shared stops being used.
          </Callout>
        </div>
      </div>
    </div>
  );
}

function MemberStatus({ outcome, role, isMe }: Readonly<{ outcome: Outcome; role: string; isMe: boolean }>) {
  if (role === 'viewer') return <Tag>Viewers can’t start runs</Tag>;
  if (outcome.kind === 'account') {
    const word = TIER_WORD[outcome.tier];
    return <Tag tone={outcome.tier === 'team' ? 'info' : 'accent'}>{isMe ? word.replace('Their', 'Your') : word}</Tag>;
  }
  if (outcome.kind === 'halt') return <Tag tone="danger">Stopped</Tag>;
  return <Tag tone="warning">No account — can’t run</Tag>;
}
