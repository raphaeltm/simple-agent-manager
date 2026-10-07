/**
 * Eventing guidance for get_instructions: when to subscribe instead of polling,
 * how to use a shared feature coordination channel, and how to report failures.
 * It claims only what has been verified end to end.
 */
export function buildEventingInstructions(input: {
  coordinationChannel: string | null;
  agentMessageChannelsEnabled: boolean;
}): string[] {
  const instructions = [
    'Waiting on a PR or CI with nothing else to do: rather than polling, call `create_project_event_subscription` ' +
      '(requestedDelivery "existing_session_prompt"; source "github" with subjectType "pull_request" and subjectId = the PR number ' +
      'for reviews and comments, or subjectType "commit" and subjectId = the head SHA for check_run, check_suite and workflow_run) ' +
      'and end your turn. Verified end to end so far: a PR comment waking an idle, live chat. Waking a sleeping chat and CI or ' +
      'review delivery are not verified yet, so keep one bounded fallback check (for example `gh pr checks`) and say when you relied on it.',
    input.coordinationChannel
      ? `Your feature coordination channel is \`${input.coordinationChannel}\`, shared with your coordinator and sibling agents; ` +
        '`dispatch_task` passes it to your subtasks automatically. Publish findings, interface decisions, blockers, dependency ' +
        'readiness and completion evidence there with `publish_channel_event`; read it with `get_channel_history` or follow it ' +
        'with `follow_event_channel`.'
      : 'When you coordinate several agents on one feature, publish a short kickoff to a project event channel (for example ' +
        '`feature.<short-name>`) and pass it as `coordinationChannel` to `dispatch_task`; every descendant inherits it.',
    'If an eventing or messaging tool fails, report it visibly (`update_task_status` or your coordinator) with safe identifiers: ' +
      'the tool, channel, subscriptionId, eventId or deliveryId, and the error. A successful publish or send never proves the recipient read it.',
  ];
  if (input.agentMessageChannelsEnabled) {
    instructions.push(
      'Ordinary notify/deliver messages from other agents arrive as a SAM notice with event IDs instead of peer text: read them with `get_event`, ' +
        'reply with `send_durable_message`, then call `ack_event_delivery`.'
    );
  }
  return instructions;
}
