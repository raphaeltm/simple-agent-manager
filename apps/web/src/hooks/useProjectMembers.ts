import type {
  ProjectMemberResponse,
  ProjectMemberRole,
  ProjectMembersResponse,
  ProjectMemberStatus,
} from '@simple-agent-manager/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { getProjectMembers } from '../lib/api';
import { useQueryScope } from './useQueryScope';

/** One project member, flattened to what pickers, mentions and labels render. */
export interface ProjectMemberSummary {
  userId: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  role: ProjectMemberRole;
  status: ProjectMemberStatus;
}

/**
 * `['auth', scope, 'projects', 'members', projectId]` — `projects/members` is not in the
 * persistence allowlist, and must stay out of it: the response carries member emails.
 */
export function projectMembersQueryKey(queryScope: string, projectId: string) {
  return ['auth', queryScope, 'projects', 'members', projectId] as const;
}

function toSummary(member: ProjectMemberResponse): ProjectMemberSummary {
  return {
    userId: member.userId,
    name: member.user?.name?.trim() || null,
    email: member.user?.email ?? null,
    avatarUrl: member.user?.avatarUrl ?? member.user?.image ?? null,
    role: member.role,
    status: member.status,
  };
}

// Module scope on purpose: a stable `select` lets TanStack reuse the derived array until the
// response itself changes, so consumers can depend on it without re-running their memos.
function selectMembers(response: ProjectMembersResponse): ProjectMemberSummary[] {
  return response.members.map(toSummary);
}

const NO_MEMBERS: ProjectMemberSummary[] = [];

/**
 * The project's member list, fetched once per project and shared by every surface that needs
 * it: @mention pickers, the share dialog, and the events pages' write gate and creator labels.
 *
 * `members` is active members only — the people who can be mentioned, shared with, or act.
 * `allMembers` keeps every row (invited, suspended, removed) for labelling historical actors,
 * such as the creator of a schedule who has since left.
 */
export function useProjectMembers(projectId: string | null | undefined) {
  const queryScope = useQueryScope();
  const enabled = Boolean(queryScope && projectId);
  const query = useQuery({
    queryKey: projectMembersQueryKey(queryScope, projectId ?? ''),
    queryFn: () => getProjectMembers(projectId ?? ''),
    enabled,
    select: selectMembers,
  });

  const allMembers = query.data ?? NO_MEMBERS;
  const members = useMemo(
    () => allMembers.filter((member) => member.status === 'active'),
    [allMembers]
  );

  return {
    members,
    allMembers,
    /** No data yet. Stays true while the query is disabled (no project or signed out). */
    isPending: query.isPending,
    error: query.error,
    refetch: query.refetch,
  };
}
