import { Button, Dialog } from '@simple-agent-manager/ui';
import { useState } from 'react';

import { type Account, ACCOUNTS, AGENT_LABEL, KIND_LABEL, ME, MEMBERS, type Profile, TEAM_PROJECT, type TeamAccount } from './mock-data';
import { AgentMark, Callout, Panel, Tag, Toggle } from './parts';

export function ShareScreen({ teamAccounts, setTeamAccounts, profiles, setProfiles }: Readonly<{
  teamAccounts: TeamAccount[];
  setTeamAccounts: (next: TeamAccount[]) => void;
  profiles: Profile[];
  setProfiles: (next: Profile[]) => void;
}>) {
  const [sharing, setSharing] = useState<Account | null>(null);

  const stopSharing = (t: TeamAccount) => {
    setTeamAccounts(
      teamAccounts.map((x) =>
        x.id === t.id ? { ...x, status: 'revoked', revokedNote: 'You stopped sharing it just now' } : x,
      ),
    );
  };

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-2">
      <Panel title={`Team accounts in ${TEAM_PROJECT.name}`}>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {teamAccounts.map((t) => {
            const usedBy = profiles.filter((p) => p.teamAccountId === t.id);
            const by = MEMBERS.find((m) => m.id === t.contributedBy)?.name ?? 'someone';
            return (
              <li key={t.id} className="flex min-w-0 flex-col gap-1.5 rounded-md border border-border-default bg-inset p-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <AgentMark agentType={t.agentType} size={24} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg-primary">{t.label}</span>
                  {t.status === 'revoked' ? <Tag tone="danger">Removed</Tag> : <Tag tone="info">Active</Tag>}
                </div>
                <span className="text-xs text-fg-muted">
                  Shared by {t.contributedBy === ME ? 'you' : by} · {t.usageThisMonth} this month
                  {t.status === 'revoked' && ` · ${t.revokedNote}`}
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-fg-muted">
                  Profiles: {usedBy.length === 0 ? 'none' : usedBy.map((p) => <Tag key={p.id}>{p.name}</Tag>)}
                </span>
                {t.status === 'revoked' && usedBy.length > 0 && (
                  <span className="text-xs text-danger-fg">
                    {usedBy.length === 1 ? 'This profile is' : 'These profiles are'} stopped until an admin picks another account.
                  </span>
                )}
                {t.contributedBy === ME && t.status === 'active' && (
                  <div>
                    <Button size="sm" variant="secondary" onClick={() => stopSharing(t)}>Stop sharing</Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Panel>

      <Panel title="Your accounts">
        <p className="m-0 mb-2 text-xs text-fg-muted">
          Sharing lets other members’ runs use one of your accounts. You keep ownership and can stop at any time.
        </p>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {ACCOUNTS.map((a) => {
            const already = teamAccounts.some((t) => t.label === a.label && t.status === 'active');
            const blocked = a.kind === 'subscription';
            return (
              <li key={a.id} className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-border-default p-2.5">
                <AgentMark agentType={a.agentType} size={24} />
                <span className="min-w-0 flex-1 basis-40">
                  <span className="block truncate text-[13px] text-fg-primary" title={a.label}>{a.label}</span>
                  <span className="block text-xs text-fg-muted">
                    {KIND_LABEL[a.kind]}
                    {blocked && ' · personal sign-ins can’t be shared'}
                    {!a.active && ' · paused'}
                  </span>
                </span>
                <Button size="sm" variant="secondary" disabled={blocked || !a.active || already} onClick={() => setSharing(a)}>
                  {already ? 'Shared' : 'Share with team…'}
                </Button>
              </li>
            );
          })}
        </ul>
        <div className="mt-3">
          <Callout>
            Shared accounts are reached through SAM’s proxy. The key stays on SAM’s servers and never reaches a
            member’s workspace, so nobody can copy it from a terminal. Accounts SAM can’t proxy can’t be shared.
          </Callout>
        </div>
      </Panel>

      <ShareDialog
        key={sharing?.id ?? 'none'}
        account={sharing}
        onClose={() => setSharing(null)}
        profiles={profiles}
        onShare={(account, profileIds) => {
          const id = `ta-${account.id}`;
          setTeamAccounts([
            ...teamAccounts.filter((t) => t.id !== id),
            { id, label: account.label, agentType: account.agentType, contributedBy: ME, status: 'active', usageThisMonth: '$0' },
          ]);
          setProfiles(profiles.map((p) => (profileIds.includes(p.id) ? { ...p, teamAccountId: id } : p)));
          setSharing(null);
        }}
      />
    </div>
  );
}

function ShareDialog({ account, onClose, onShare, profiles }: Readonly<{
  account: Account | null;
  onClose: () => void;
  onShare: (account: Account, profileIds: string[]) => void;
  profiles: Profile[];
}>) {
  const [ack, setAck] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  if (!account) return null;
  const matching = profiles.filter((p) => p.agentType === account.agentType);

  return (
    <Dialog isOpen onClose={onClose} maxWidth="md">
      <h2 className="m-0 mb-1 break-words text-base font-semibold text-fg-primary">
        Share “{account.label}” with {TEAM_PROJECT.name}?
      </h2>
      <ul className="m-0 mb-3 flex list-disc flex-col gap-1 pl-5 text-[13px] text-fg-secondary">
        <li>All {MEMBERS.length - 1} other members’ runs can use it, on profiles an admin assigns it to.</li>
        <li>Usage is billed to this account. You’ll see who used it and how much.</li>
        <li>The key itself is never shown or sent to anyone’s workspace.</li>
        <li>Stopping sharing takes effect on the next run. Profiles using it stop until an admin picks another.</li>
      </ul>
      {matching.length > 0 && (
        <fieldset className="m-0 mb-3 border-0 p-0">
          <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">
            Use it on these {AGENT_LABEL[account.agentType]} profiles now (optional, admins only)
          </legend>
          {matching.map((p) => (
            <Toggle
              key={p.id}
              checked={selected.includes(p.id)}
              onChange={(on) => setSelected(on ? [...selected, p.id] : selected.filter((id) => id !== p.id))}
              label={p.name}
            />
          ))}
        </fieldset>
      )}
      <Toggle checked={ack} onChange={setAck} label="I understand other members’ runs will spend from this account" />
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button disabled={!ack} onClick={() => onShare(account, selected)}>Share account</Button>
      </div>
    </Dialog>
  );
}
