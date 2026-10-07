/**
 * Feature coordination channel carried through dispatch (preview). The value is
 * an ordinary project event channel: explicit on dispatch, else inherited from
 * the dispatching task, so children and later descendants share one channel
 * instead of inventing their own. Channels stay project-visible; this routes
 * guidance and is not an access boundary.
 */
import { isAgentMessageChannelName } from '../../durable-objects/project-data/agent-message-notice';
import {
  channelName,
  type ProjectEventChannelEnv,
} from '../../durable-objects/project-data/project-event-channels-config';
import { INVALID_PARAMS, jsonRpcError, type JsonRpcResponse } from './_helpers';

export function parseCoordinationChannelParam(
  requestId: string | number | null,
  value: unknown,
  env: ProjectEventChannelEnv
): { value: string | undefined } | JsonRpcResponse {
  if (value === undefined) return { value: undefined };
  if (typeof value !== 'string') {
    return jsonRpcError(requestId, INVALID_PARAMS, 'coordinationChannel must be a string');
  }
  let name: string;
  try {
    name = channelName(value, env);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return jsonRpcError(requestId, INVALID_PARAMS, `coordinationChannel: ${reason}`);
  }
  if (isAgentMessageChannelName(name)) {
    return jsonRpcError(
      requestId,
      INVALID_PARAMS,
      'coordinationChannel cannot use the agent-dm. prefix reserved for SAM agent messaging'
    );
  }
  return { value: name };
}

/** Child-description guidance, placed at the point of work. */
export function coordinationChannelSection(channel: string): string {
  return [
    '## Coordination channel',
    `This work shares the project event channel \`${channel}\` with its coordinator and sibling agents; dispatch_task passes it to your own subtasks automatically.`,
    `- Publish findings, interface decisions, blockers, dependency readiness and completion evidence with publish_channel_event (channel "${channel}", one stable idempotencyKey per message). Skip routine progress.`,
    '- Read it with get_channel_history, or follow it with follow_event_channel: requestedDelivery "existing_session_prompt" to be woken, "record_only" to keep a history feed.',
    '- If a channel call fails, report it with update_task_status naming the channel, tool and error; do not silently stop using it.',
  ].join('\n');
}
