import type { SessionAccessGrant } from '@simple-agent-manager/shared';
import { Avatar, Button, Spinner } from '@simple-agent-manager/ui';
import { useId, useMemo, useState } from 'react';

import { type ProjectMemberSummary, useProjectMembers } from '../../hooks/useProjectMembers';
import { memberMentionLabel } from './comments/comment-mentions';

/** Show a search field once the list is long enough to need one. */
const SEARCH_THRESHOLD = 6;

/** "Ada Lovelace", else the email's local part — the same label mentions use. */
export function memberLabel(member: ProjectMemberSummary): string {
  return memberMentionLabel(member) ?? 'This teammate';
}

/**
 * The "Add a teammate" half of the share dialog: active project members who could be given
 * access. Excludes the owner, anyone who already has access, and the viewer. View-only members
 * cannot drive a session (the server refuses them), so they are left out and the omission is
 * said out loud instead of silently shrinking the list.
 */
export function AddTeammateSection({
  projectId,
  ownerUserId,
  viewerUserId,
  grants,
  onPick,
}: Readonly<{
  projectId: string;
  ownerUserId: string | null;
  viewerUserId: string;
  grants: readonly SessionAccessGrant[];
  onPick: (member: ProjectMemberSummary) => void;
}>) {
  const headingId = useId();
  const searchId = useId();
  const [search, setSearch] = useState('');
  const { members, isPending, error, refetch } = useProjectMembers(projectId);

  const { candidates, viewOnlyCount, othersCount } = useMemo(() => {
    const hasAccess = new Set(grants.map((grant) => grant.grantee.id));
    const others = members.filter(
      (member) =>
        member.userId !== viewerUserId &&
        member.userId !== ownerUserId &&
        !hasAccess.has(member.userId)
    );
    const eligible = others
      .filter((member) => member.role !== 'viewer')
      .sort((a, b) => memberLabel(a).localeCompare(memberLabel(b)));
    return {
      candidates: eligible,
      viewOnlyCount: others.length - eligible.length,
      othersCount: members.filter(
        (member) => member.userId !== viewerUserId && member.userId !== ownerUserId
      ).length,
    };
  }, [grants, members, ownerUserId, viewerUserId]);

  const query = search.trim().toLowerCase();
  const visible = query
    ? candidates.filter(
        (member) =>
          memberLabel(member).toLowerCase().includes(query) ||
          (member.email ?? '').toLowerCase().includes(query)
      )
    : candidates;

  return (
    <section aria-labelledby={headingId} className="mt-5">
      <h3
        id={headingId}
        className="m-0 text-xs font-semibold tracking-wide text-fg-muted uppercase"
      >
        Add a teammate
      </h3>

      {isPending && members.length === 0 ? (
        <p role="status" className="m-0 mt-2 flex items-center gap-2 text-sm text-fg-muted">
          <Spinner size="sm" />
          Loading teammates…
        </p>
      ) : error && members.length === 0 ? (
        <div role="alert" className="mt-2 text-sm text-danger-fg">
          <p className="m-0">Couldn&apos;t load your teammates.</p>
          <Button
            size="sm"
            variant="ghost"
            className="mt-2 min-h-11 sm:min-h-9"
            onClick={() => void refetch()}
          >
            Try again
          </Button>
        </div>
      ) : candidates.length === 0 ? (
        <p className="m-0 mt-2 text-sm text-fg-muted">
          {othersCount === 0
            ? 'No one else is in this project yet.'
            : viewOnlyCount > 0 && viewOnlyCount === othersCount
              ? 'Everyone else in this project can only view it.'
              : 'Everyone who can be added already has access.'}
        </p>
      ) : (
        <>
          {candidates.length > SEARCH_THRESHOLD && (
            <>
              <label htmlFor={searchId} className="sr-only">
                Search teammates
              </label>
              <input
                id={searchId}
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search teammates"
                autoComplete="off"
                className="mt-2 block min-h-11 w-full min-w-0 rounded-md border border-border-default bg-inset px-3 text-base text-fg-primary placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent sm:text-sm"
              />
            </>
          )}
          {visible.length === 0 ? (
            <p className="m-0 mt-2 text-sm text-fg-muted">No teammates match.</p>
          ) : (
            <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
              {visible.map((member) => {
                const label = memberLabel(member);
                return (
                  <li key={member.userId} className="min-w-0">
                    <button
                      type="button"
                      onClick={() => onPick(member)}
                      aria-label={`Share with ${label}`}
                      className="flex min-h-14 w-full min-w-0 cursor-pointer items-center gap-3 rounded-md border border-border-default bg-transparent px-3 py-2 text-left transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
                    >
                      <Avatar name={label} imageUrl={member.avatarUrl} tone="human" size="lg" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-fg-primary [overflow-wrap:anywhere]">
                          {label}
                        </span>
                        {member.email && member.email !== label && (
                          <span className="block truncate text-xs text-fg-muted">
                            {member.email}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-xs font-medium text-accent">Add</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {viewOnlyCount > 0 && candidates.length > 0 && (
        <p className="m-0 mt-2 text-xs text-fg-muted">View-only members can&apos;t be added.</p>
      )}
    </section>
  );
}
