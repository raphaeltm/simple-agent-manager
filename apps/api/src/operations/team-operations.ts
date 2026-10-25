import * as v from 'valibot';

import { OperationError } from './errors';
import { teamStatus } from './team-core';
import type { TeamScope } from './team-lineage';
import { defineOperation } from './types';

const id = v.pipe(v.string(), v.minLength(1));

export const samTeamStatus = defineOperation({
  name: 'sam_team_status',
  title: 'Team progress and evidence',
  kind: 'read',
  description:
    'Use this when you need one view of a team of agents instead of reading every chat: a task and its subtasks (taskId), the task behind a chat (sessionId), or every task dispatched with one coordination channel (channel). Per task: status; working, idle, sleeping or superseded; what it is waiting on (a person, a provider limit reset, credentials, node capacity, the next message); open questions; chat link; agent and billing mode; pull request with head commit and checks; the agent-reported summary and evidence (claims, not verified); measured runtime. Usage shows provider-reported subscription windows and SAM AI proxy metering; per-task token counts and deployed commits are not recorded and are reported as such. Bounded and disclosed when truncated. Reads never wake compute.',
  input: v.object({
    projectId: id,
    taskId: v.optional(id),
    sessionId: v.optional(id),
    channel: v.optional(id),
  }),
  run(ctx, input) {
    const scopes: TeamScope[] = [
      ...(input.taskId ? [{ kind: 'task' as const, taskId: input.taskId }] : []),
      ...(input.sessionId ? [{ kind: 'chat' as const, sessionId: input.sessionId }] : []),
      ...(input.channel ? [{ kind: 'channel' as const, channel: input.channel }] : []),
    ];
    const [scope] = scopes;
    if (scopes.length !== 1 || !scope) {
      throw new OperationError(
        'invalid_input',
        'Supply exactly one of taskId, sessionId or channel'
      );
    }
    return teamStatus(ctx, { projectId: input.projectId, scope });
  },
});

export const teamOperations = [samTeamStatus] as const;
