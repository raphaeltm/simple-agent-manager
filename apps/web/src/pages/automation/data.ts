/**
 * Data hooks for the Automation page. Lists come from TanStack Query (rule 48: stale data stays
 * on screen while a refetch runs), and every mutation refreshes through {@link
 * useInvalidateAutomation} instead of reloading the page (rule 16).
 */
import type { TriggerExecutionResponse, TriggerResponse } from '@simple-agent-manager/shared';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { useProjectMembers } from '../../hooks/useProjectMembers';
import { useQueryScope } from '../../hooks/useQueryScope';
import {
  AUTOMATION_ATTENTION_WINDOW_MS,
  AUTOMATION_CHAT_PICKER_LIMIT,
  AUTOMATION_PREVIEW_ROWS,
  AUTOMATION_RECENT_RUNS_PER_TRIGGER,
} from '../../lib/automation-config';
import { AUTOMATION_POLL_MS } from '../../lib/poll-intervals';
import {
  agentProfilesQueryOptions,
  automationQueryKeys,
  projectChatSessionsQueryOptions,
  projectSkillsQueryOptions,
  recentRunsQueryOptions,
  schedulesQueryOptions,
  triggerQueryKeys,
  triggersQueryOptions,
  watchesQueryOptions,
} from '../../lib/query-options';
import { useProjectContext } from '../ProjectContext';
import { buildActivity } from './activity';
import { buildAutomationItems } from './model';

type RunsResult = { data?: TriggerExecutionResponse[]; isError: boolean };

// Module scope so `useQueries` only re-combines when a run query actually changed.
function combineRuns(results: RunsResult[]): RunsResult[] {
  return results.map((result) => ({ data: result.data, isError: result.isError }));
}

/**
 * Triggers whose runs the overview needs. There is no project-wide run feed, so this is one
 * request per trigger: paused ones (the attention rule reads their failure streak) and the few
 * that fired most recently ("Recently"). History asks for all of them.
 */
export function triggersNeedingRuns(triggers: TriggerResponse[], scope: 'overview' | 'all') {
  if (scope === 'all') return triggers;
  const recent = [...triggers]
    .filter((trigger) => trigger.lastTriggeredAt)
    .sort((a, b) => (b.lastTriggeredAt ?? '').localeCompare(a.lastTriggeredAt ?? ''))
    .slice(0, AUTOMATION_PREVIEW_ROWS);
  const wanted = new Set([
    ...triggers.filter((trigger) => trigger.status === 'paused').map((trigger) => trigger.id),
    ...recent.map((trigger) => trigger.id),
  ]);
  return triggers.filter((trigger) => wanted.has(trigger.id));
}

/** Everything the overview, History and the chat panel read, as one view model. */
export function useAutomationData(
  projectId: string,
  { runs: runScope = 'overview' }: { runs?: 'overview' | 'all' } = {}
) {
  const queryScope = useQueryScope();
  const enabled = Boolean(queryScope);
  const triggers = useQuery({ ...triggersQueryOptions(queryScope, projectId), enabled });
  const schedules = useQuery({
    ...schedulesQueryOptions(queryScope, projectId),
    enabled,
    refetchInterval: AUTOMATION_POLL_MS,
  });
  const watches = useQuery({
    ...watchesQueryOptions(queryScope, projectId),
    enabled,
    refetchInterval: AUTOMATION_POLL_MS,
  });
  const triggerList = triggers.data;
  const runTriggers = useMemo(
    () => triggersNeedingRuns(triggerList ?? [], runScope),
    [runScope, triggerList]
  );
  const runResults = useQueries({
    queries: runTriggers.map((trigger) => ({
      ...recentRunsQueryOptions(
        queryScope,
        projectId,
        trigger.id,
        AUTOMATION_RECENT_RUNS_PER_TRIGGER
      ),
      enabled,
    })),
    combine: combineRuns,
  });

  const runsByTrigger = useMemo(() => {
    const map = new Map<string, TriggerExecutionResponse[]>();
    runTriggers.forEach((trigger, index) => {
      const runs = runResults[index]?.data;
      if (runs) map.set(trigger.id, runs);
    });
    return map;
  }, [runResults, runTriggers]);

  const scheduleList = schedules.data?.items;
  const watchList = watches.data?.items;
  const items = useMemo(
    () =>
      buildAutomationItems(
        {
          triggers: triggerList ?? [],
          runsByTrigger,
          schedules: scheduleList ?? [],
          watches: watchList ?? [],
        },
        Date.now(),
        AUTOMATION_ATTENTION_WINDOW_MS
      ),
    [runsByTrigger, scheduleList, triggerList, watchList]
  );
  const activity = useMemo(
    () => buildActivity(triggerList ?? [], runsByTrigger, scheduleList ?? []),
    [runsByTrigger, scheduleList, triggerList]
  );

  const sources = [triggers, schedules, watches];
  return {
    items,
    activity,
    /** True only before the first response of every list: the one moment a spinner may show. */
    isPending: sources.every((query) => query.isPending),
    /** Lists that failed; the page names them instead of hiding what did load. */
    failed: [
      triggers.isError ? 'recurring and reacting automations' : null,
      schedules.isError ? 'one-time automations' : null,
      watches.isError ? 'event watches' : null,
    ].filter((name): name is string => name !== null),
    runsFailed: runResults.some((result) => result.isError),
    truncated: Boolean(schedules.data?.truncated || watches.data?.truncated),
    refetch: () => Promise.all(sources.map((query) => query.refetch())),
  };
}

/** Names for the ids automations point at: chats, agent profiles and skills. */
export function useAutomationLookups(projectId: string) {
  const queryScope = useQueryScope();
  const enabled = Boolean(queryScope);
  const chats = useQuery({
    ...projectChatSessionsQueryOptions(queryScope, projectId, AUTOMATION_CHAT_PICKER_LIMIT),
    enabled,
  });
  const profiles = useQuery({ ...agentProfilesQueryOptions(queryScope, projectId), enabled });
  const skills = useQuery({ ...projectSkillsQueryOptions(queryScope, projectId), enabled });
  const chatList = chats.data;
  const profileList = profiles.data;
  const skillList = skills.data;
  return useMemo(() => {
    const chatTitle = (sessionId: string) => {
      const chat = chatList?.find((item) => item.id === sessionId);
      return chat?.topic?.trim() || `Chat ${sessionId.slice(0, 8)}`;
    };
    const profileName = (profileId: string | null) =>
      profileId
        ? (profileList?.find((item) => item.id === profileId)?.name ?? 'an agent profile')
        : 'the project default agent';
    const skillName = (skillId: string | null) =>
      skillId ? (skillList?.find((item) => item.id === skillId)?.name ?? 'a skill') : null;
    return {
      chats: chatList ?? [],
      profiles: profileList ?? [],
      skills: skillList ?? [],
      chatTitle,
      profileName,
      skillName,
    };
  }, [chatList, profileList, skillList]);
}

export type AutomationLookups = ReturnType<typeof useAutomationLookups>;

/** Refreshes every automation read after a change, wherever it was shown. */
export function useInvalidateAutomation() {
  const queryClient = useQueryClient();
  const queryScope = useQueryScope();
  return useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: automationQueryKeys.all(queryScope) }),
        queryClient.invalidateQueries({ queryKey: triggerQueryKeys.all(queryScope) }),
      ]),
    [queryClient, queryScope]
  );
}

/**
 * Who may change automation: the project owner and active members other than viewers. The
 * API enforces the same rule (`task:write`); the UI hides controls a viewer cannot use.
 */
export function useAutomationAccess() {
  const { projectId, project } = useProjectContext();
  const queryScope = useQueryScope();
  const members = useProjectMembers(projectId);
  const member = members.members.find((item) => item.userId === queryScope);
  const canWrite = project?.userId === queryScope || Boolean(member && member.role !== 'viewer');
  const { allMembers } = members;
  // Every member row, not only active ones: a creator keeps their name after leaving.
  const personName = useCallback(
    (userId: string) => {
      if (userId === queryScope) return 'you';
      return allMembers.find((item) => item.userId === userId)?.name || 'a former member';
    },
    [allMembers, queryScope]
  );
  return {
    canWrite,
    /** Still finding out; the read-only notice waits for this. */
    checking: !canWrite && members.isPending,
    userId: queryScope,
    personName,
  };
}
