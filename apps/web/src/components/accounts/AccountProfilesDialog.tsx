/**
 * Choose which of my agent profiles run on an existing account. Opened from an
 * account card in Settings → Agents. Checking a profile runs it on this account
 * when I use it (replacing any other account I picked for it); unchecking puts
 * it back on my usual account. Only profiles for this account's agent are
 * listed, and in shared projects the choice is mine alone.
 */
import type { CCProfilePinCandidate } from '@simple-agent-manager/shared';
import { Button, Dialog } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import { useQueryScope } from '../../hooks/useQueryScope';
import { profilePinCandidatesQueryOptions } from '../../lib/query-options';
import type { AccountView, ProviderAccounts } from './account-model';
import { ProviderMark } from './AccountBits';
import {
  describeProfilePinChanges,
  type ProfilePinChanges,
  useAccountActions,
} from './useAccountActions';

/** Show the filter once the list stops fitting comfortably on a phone. */
const SEARCH_THRESHOLD = 8;

export interface AccountProfilesDialogProps {
  account: AccountView;
  group: ProviderAccounts;
  onClose: () => void;
}

interface ProfileGroup {
  key: string;
  title: string;
  profiles: CCProfilePinCandidate[];
}

function groupByProject(profiles: CCProfilePinCandidate[]): ProfileGroup[] {
  const groups = new Map<string, ProfileGroup>();
  for (const profile of profiles) {
    const key = profile.projectId ?? '';
    const existing = groups.get(key);
    if (existing) existing.profiles.push(profile);
    else {
      groups.set(key, {
        key,
        title: profile.projectId
          ? (profile.projectName ?? 'Project')
          : 'Your profiles · every project',
        profiles: [profile],
      });
    }
  }
  return [...groups.values()];
}

export function AccountProfilesDialog({
  account,
  group,
  onClose,
}: Readonly<AccountProfilesDialogProps>) {
  const titleId = useId();
  const actions = useAccountActions();
  const queryScope = useQueryScope();
  const candidates = useQuery({
    ...profilePinCandidatesQueryOptions(queryScope, account.target),
    enabled: Boolean(queryScope),
  });
  const pinIdByProfile = useMemo(
    () => new Map(account.profilePins.map((pin) => [pin.agentProfileId, pin.id])),
    [account.profilePins]
  );
  /** Profiles another of my accounts runs, so checking one here replaces that choice. */
  const otherAccountByProfile = useMemo(() => {
    const map = new Map<string, string>();
    for (const other of group.accounts) {
      if (other.id === account.id) continue;
      for (const pin of other.profilePins) map.set(pin.agentProfileId, other.label);
    }
    return map;
  }, [group.accounts, account.id]);

  // Only the profiles I toggled, keyed to the state I chose. Everything else
  // follows the current pins, so a refetch while the dialog is open (or pins that
  // finish loading after it opened) never turns into an unpin I didn't make.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);

  const isSelected = (profileId: string) => toggled.get(profileId) ?? pinIdByProfile.has(profileId);
  const changes: ProfilePinChanges = { pin: [], unpin: [] };
  for (const [profileId, checked] of toggled) {
    const pinId = pinIdByProfile.get(profileId);
    if (checked && !pinId) changes.pin.push(profileId);
    else if (!checked && pinId) changes.unpin.push(pinId);
  }
  const changed = changes.pin.length + changes.unpin.length > 0;
  const profiles = candidates.data?.profiles ?? [];
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? profiles.filter(
        (profile) =>
          profile.name.toLowerCase().includes(needle) ||
          (profile.projectName ?? '').toLowerCase().includes(needle)
      )
    : profiles;
  const groups = groupByProject(shown);

  const toggle = (profileId: string) =>
    setToggled((current) =>
      new Map(current).set(profileId, !(current.get(profileId) ?? pinIdByProfile.has(profileId)))
    );

  const save = async () => {
    setSaving(true);
    const ok = await actions.updateProfilePins(account, changes);
    setSaving(false);
    if (ok) onClose();
  };

  return (
    <Dialog isOpen onClose={onClose} maxWidth="md" aria-labelledby={titleId}>
      <div className="flex min-w-0 flex-col gap-3" data-testid="account-profiles-dialog">
        <div className="flex min-w-0 items-start gap-2.5">
          <ProviderMark provider={group.provider} size={30} />
          <div className="min-w-0">
            <h2
              id={titleId}
              title={account.label}
              className="m-0 line-clamp-2 text-base font-semibold text-fg-primary break-words [overflow-wrap:anywhere]"
            >
              Use {account.label} in profiles
            </h2>
            <p className="m-0 mt-0.5 text-xs text-fg-muted">
              Only {group.provider.name} profiles are listed. When you run a checked profile, it
              uses this account. In shared projects this sets only your account; other members
              aren’t affected.
            </p>
          </div>
        </div>

        {profiles.length > SEARCH_THRESHOLD && (
          <label className="flex min-h-9 items-center gap-2 rounded-md border border-border-default bg-inset px-2.5 focus-within:ring-2 focus-within:ring-[var(--sam-color-focus-ring)]">
            <Search size={14} aria-hidden="true" className="shrink-0 text-fg-muted" />
            <span className="sr-only">Search profiles</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search profiles"
              className="min-w-0 flex-1 border-none bg-transparent py-1.5 text-sm text-fg-primary outline-none"
            />
          </label>
        )}

        <div className="flex max-h-[min(24rem,55dvh)] min-w-0 flex-col gap-2 overflow-y-auto">
          {candidates.isPending && (
            <p className="m-0 px-1 py-4 text-center text-xs text-fg-muted">Loading profiles…</p>
          )}
          {candidates.error && !candidates.data && (
            <p className="m-0 px-1 py-4 text-center text-xs text-danger-fg">
              Couldn’t load your profiles.{' '}
              <button
                type="button"
                onClick={() => void candidates.refetch()}
                className="cursor-pointer border-none bg-transparent p-0 text-xs text-accent underline"
              >
                Try again
              </button>
            </p>
          )}
          {groups.map((profileGroup) => (
            <section key={profileGroup.key} className="min-w-0">
              <h3 className="m-0 mb-1 truncate px-1 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
                {profileGroup.title}
              </h3>
              <ul className="m-0 flex min-w-0 list-none flex-col rounded-md border border-border-default p-0">
                {profileGroup.profiles.map((profile) => (
                  <li key={profile.id} className="border-b border-border-default last:border-b-0">
                    <label className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2.5 px-3 py-2 hover:bg-surface-hover">
                      <input
                        type="checkbox"
                        checked={isSelected(profile.id)}
                        onChange={() => toggle(profile.id)}
                        className="h-3.5 w-3.5 shrink-0 accent-[var(--sam-color-focus-ring)]"
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span
                          className="line-clamp-2 break-words text-sm text-fg-primary"
                          title={profile.name}
                        >
                          {profile.name}
                        </span>
                        <span className="truncate text-[11px] text-fg-muted">
                          {describeCurrent(profile.id, pinIdByProfile, otherAccountByProfile)}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {candidates.data && shown.length === 0 && (
            <p className="m-0 px-1 py-4 text-center text-xs italic text-fg-muted">
              {profiles.length === 0
                ? `You have no ${group.provider.name} profiles yet.`
                : 'No profile matches.'}
            </p>
          )}
          {candidates.data?.truncated && (
            <p className="m-0 px-1 text-[11px] text-fg-muted">
              Showing the first {candidates.data.limit} profiles. Pick others from the profile
              itself.
            </p>
          )}
        </div>

        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <span
            className="min-w-0 flex-1 text-[11px] text-fg-muted [overflow-wrap:anywhere]"
            aria-live="polite"
          >
            {changed ? describeProfilePinChanges(account.label, changes) : 'No changes'}
          </span>
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            loading={saving}
            disabled={!changed}
            onClick={() => void save()}
          >
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function describeCurrent(
  profileId: string,
  pinIdByProfile: ReadonlyMap<string, string>,
  otherAccountByProfile: ReadonlyMap<string, string>
): string {
  if (pinIdByProfile.has(profileId)) return 'Uses this account';
  const other = otherAccountByProfile.get(profileId);
  if (other) return `Uses ${other} — checking replaces it`;
  return 'Uses your usual account';
}
