import { Button, Dialog } from '@simple-agent-manager/ui';
import { useMemo, useState } from 'react';

import {
  ACCOUNTS,
  AGENT_LABEL,
  must,
  type PersonalChoices,
  type Profile,
  SOLO_PROFILES,
  SOLO_PROJECT,
  TEAM_PROFILES,
  TEAM_PROJECT,
} from './mock-data';
import { accountOptions, AccountPicker, AgentMark, Callout, Ladder, OutcomeLine, Panel, Tag } from './parts';
import { resolveAccount } from './resolve';

const INHERIT = '__inherit__';

export function ProfileList({ profiles, selectedId, onSelect, badge }: Readonly<{
  profiles: Profile[];
  selectedId: string;
  onSelect: (id: string) => void;
  badge: (profile: Profile) => React.ReactNode;
}>) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label="Profiles">
      {profiles.map((p) => (
        <li key={p.id}>
          <button
            type="button"
            onClick={() => onSelect(p.id)}
            aria-current={p.id === selectedId}
            className={`flex min-h-14 w-full min-w-0 items-center gap-2.5 rounded-md border px-2.5 py-2 text-left ${
              p.id === selectedId ? 'border-accent bg-accent-tint' : 'border-border-default bg-surface hover:bg-surface-hover'
            }`}
          >
            <AgentMark agentType={p.agentType} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-fg-primary" title={p.name}>{p.name}</span>
              <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1">{badge(p)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function SoloScreen({ choices, setChoices }: Readonly<{
  choices: PersonalChoices;
  setChoices: (next: PersonalChoices) => void;
}>) {
  const [selectedId, setSelectedId] = useState(must(SOLO_PROFILES[0], 'a solo profile').id);
  const [dialogOpen, setDialogOpen] = useState(false);
  const profile = must(SOLO_PROFILES.find((p) => p.id === selectedId), 'the selected profile');

  const resolve = (p: Profile) =>
    resolveAccount({ profile: p, projectId: SOLO_PROJECT.id, choices, accounts: ACCOUNTS, teamAccounts: [], includeTeamTier: false });
  const resolution = resolve(profile);
  const inherited = resolveAccount({
    profile,
    projectId: SOLO_PROJECT.id,
    choices: { ...choices, profilePins: {} },
    accounts: ACCOUNTS,
    teamAccounts: [],
    includeTeamTier: false,
  });
  const inheritedLabel = inherited.outcome.kind === 'account' ? inherited.outcome.label : 'nothing — no account connected';
  const pin = choices.profilePins[profile.id];
  const pinApplies = !pin || ACCOUNTS.find((a) => a.id === pin)?.agentType === resolution.runAgentType;

  const setPin = (value: string) => {
    const profilePins = { ...choices.profilePins };
    if (value === INHERIT) delete profilePins[profile.id];
    else profilePins[profile.id] = value;
    setChoices({ ...choices, profilePins });
  };

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-3">
        <h2 className="m-0 text-xs font-semibold uppercase tracking-wide text-fg-muted">
          Profiles in {SOLO_PROJECT.name}
        </h2>
        <ProfileList
          profiles={SOLO_PROFILES}
          selectedId={selectedId}
          onSelect={setSelectedId}
          badge={(p) => {
            const r = resolve(p);
            const pinned = Boolean(choices.profilePins[p.id]);
            return (
              <>
                {p.scope === 'personal' && <Tag>All my projects</Tag>}
                {r.outcome.kind === 'account' && (
                  <Tag tone={pinned ? 'info' : 'muted'}>{pinned ? '📌 ' : ''}{r.outcome.label}</Tag>
                )}
                {r.outcome.kind === 'halt' && <Tag tone="danger">Paused account</Tag>}
                {r.outcome.kind === 'none' && <Tag tone="warning">No account</Tag>}
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
              <span className="truncate">Edit profile · {profile.name}</span>
            </span>
          }
        >
          <dl className="m-0 mb-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]">
            <dt className="text-fg-muted">Agent</dt>
            <dd className="m-0 text-fg-primary">{AGENT_LABEL[profile.agentType]}</dd>
            <dt className="text-fg-muted">Model</dt>
            <dd className="m-0 truncate text-fg-primary">{profile.model}</dd>
          </dl>

          <h4 className="m-0 mb-1 text-[13px] font-semibold text-fg-primary">Account</h4>
          <p className="m-0 mb-2 text-xs text-fg-muted">
            Which {AGENT_LABEL[profile.agentType]} account this profile runs on.
            {profile.scope === 'personal' && ' This profile is yours, so the choice applies in every project.'}
          </p>
          <AccountPicker
            name={`solo-${profile.id}`}
            value={pin ?? INHERIT}
            onChange={setPin}
            options={[
              { value: INHERIT, label: 'Use my usual account', hint: `Right now: ${inheritedLabel}` },
              ...accountOptions(ACCOUNTS, profile.agentType).map((o) =>
                o.value === pin && o.disabled ? { ...o, disabled: false } : o,
              ),
            ]}
          />
          {!pinApplies && (
            <p className="m-0 mt-2 text-xs text-warning-fg">
              This profile’s skill switches the agent to {AGENT_LABEL[resolution.runAgentType]}, so the pinned{' '}
              {AGENT_LABEL[profile.agentType]} account doesn’t apply to those runs.
            </p>
          )}
          {profile.skillAgentType && pinApplies && (
            <p className="m-0 mt-2 text-xs text-fg-muted">
              Runs started with its skill use {AGENT_LABEL[profile.skillAgentType]}, so a {AGENT_LABEL[profile.agentType]}{' '}
              pin won’t apply to them.
            </p>
          )}
        </Panel>

        <Panel title="Which account runs">
          <div className="flex flex-col gap-3">
            <OutcomeLine outcome={resolution.outcome} agentType={resolution.runAgentType} />
            <Ladder resolution={resolution} />
          </div>
        </Panel>

        <SettingsAgentsCard choices={choices} onOpen={() => setDialogOpen(true)} />

        <Callout>
          If you invite someone to this project later, nothing here changes for you, and none of it carries
          over to them. They see the same profiles and pick their own accounts.
        </Callout>
      </div>

      <UseInProfilesDialog
        isOpen={dialogOpen}
        onClose={() => setDialogOpen(false)}
        choices={choices}
        setChoices={setChoices}
      />
    </div>
  );
}

function SettingsAgentsCard({ choices, onOpen }: Readonly<{ choices: PersonalChoices; onOpen: () => void }>) {
  const account = must(ACCOUNTS.find((a) => a.id === 'a-max'), 'the Max account');
  const usedBy = [...SOLO_PROFILES, ...TEAM_PROFILES].filter((p) => choices.profilePins[p.id] === account.id);
  return (
    <Panel title="Settings → Agents (an account card)">
      <article className="relative flex min-w-0 flex-col gap-2 rounded-lg border border-[color-mix(in_srgb,var(--sam-color-accent-primary)_45%,transparent)] bg-surface p-3 pl-4">
        <span aria-hidden="true" className="absolute inset-y-2.5 left-1.5 w-1 rounded-full" style={{ background: account.swatch }} />
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg-primary">{account.label}</span>
          <Tag tone="accent">★ Default</Tag>
        </div>
        <div className="flex min-w-0 flex-col gap-1 text-xs text-fg-muted">
          <span>Projects: everything without a pin · Pinned in {TEAM_PROJECT.name}: no</span>
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            Profiles:{' '}
            {usedBy.length === 0 ? 'none' : usedBy.map((p) => <Tag key={p.id} tone="info">📌 {p.name}</Tag>)}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary">Use in projects…</Button>
          <Button size="sm" variant="secondary" onClick={onOpen}>Use in profiles…</Button>
        </div>
      </article>
    </Panel>
  );
}

function UseInProfilesDialog({ isOpen, onClose, choices, setChoices }: Readonly<{
  isOpen: boolean;
  onClose: () => void;
  choices: PersonalChoices;
  setChoices: (next: PersonalChoices) => void;
}>) {
  const account = must(ACCOUNTS.find((a) => a.id === 'a-max'), 'the Max account');
  const [query, setQuery] = useState('');
  const groups = useMemo(
    () => [
      { project: `${SOLO_PROJECT.name} · just you`, profiles: SOLO_PROFILES },
      { project: `${TEAM_PROJECT.name} · 6 members`, profiles: TEAM_PROFILES },
    ].map((g) => ({
      ...g,
      profiles: g.profiles.filter(
        (p) => p.agentType === account.agentType && p.name.toLowerCase().includes(query.toLowerCase()),
      ),
    })),
    [account.agentType, query],
  );

  const toggle = (p: Profile) => {
    const profilePins = { ...choices.profilePins };
    if (profilePins[p.id] === account.id) delete profilePins[p.id];
    else profilePins[p.id] = account.id;
    setChoices({ ...choices, profilePins });
  };

  return (
    <Dialog isOpen={isOpen} onClose={onClose} maxWidth="md">
      <h2 className="m-0 mb-1 text-base font-semibold text-fg-primary">Use “{account.label}” in profiles</h2>
      <p className="m-0 mb-3 text-xs text-fg-muted">
        Only {AGENT_LABEL[account.agentType]} profiles are listed. In shared projects this sets <em>your</em>{' '}
        account for the profile; other members aren’t affected.
      </p>
      <input
        aria-label="Search profiles"
        placeholder="Search profiles"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="mb-3 min-h-10 w-full rounded-sm border border-border-default bg-inset px-2.5 text-sm text-fg-primary"
      />
      <div className="flex max-h-[50vh] flex-col gap-3 overflow-auto">
        {groups.map((g) => (
          <div key={g.project}>
            <h3 className="m-0 mb-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">{g.project}</h3>
            {g.profiles.length === 0 && <p className="m-0 text-xs text-fg-muted">No matching profiles.</p>}
            {g.profiles.map((p) => {
              const other = choices.profilePins[p.id] && choices.profilePins[p.id] !== account.id
                ? ACCOUNTS.find((a) => a.id === choices.profilePins[p.id])?.label
                : null;
              const locked = Boolean(p.teamAccountId && !p.allowPersonal);
              return (
                <label key={p.id} className={`flex min-h-11 min-w-0 items-start gap-2.5 py-1.5 ${locked ? 'opacity-60' : 'cursor-pointer'}`}>
                  <input
                    type="checkbox"
                    className="mt-1 shrink-0 accent-[var(--sam-color-accent-primary)]"
                    checked={choices.profilePins[p.id] === account.id}
                    disabled={locked}
                    onChange={() => toggle(p)}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] text-fg-primary">{p.name}</span>
                    <span className="block text-xs text-fg-muted">
                      {locked
                        ? 'Team account required by an admin'
                        : other
                          ? `Currently uses ${other} — checking replaces it`
                          : 'Uses your usual account today'}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-4 flex justify-end">
        <Button onClick={onClose}>Done</Button>
      </div>
    </Dialog>
  );
}
