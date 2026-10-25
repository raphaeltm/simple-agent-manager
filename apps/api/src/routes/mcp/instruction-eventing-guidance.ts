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
    'Waiting on a PR or CI: reconcile the current PR head and checks before waiting, immediately after subscribing, and after every resume. ' +
      'If checks already finished, continue the existing review/release gates instead of waiting for another completion event. ' +
      'For CI call `create_project_event_subscription` with requestedDelivery "existing_session_prompt", source "github", ' +
      'subjectType "commit", subjectId = the full 40-character PR head SHA (never abbreviated), and exact eventType values ' +
      '"check_run.completed", "check_suite.completed", "workflow_run.completed"; bare names do not match. ' +
      'For reviews/comments use subjectType "pull_request" and subjectId = the PR number. ' +
      'Verified end to end so far: a PR comment waking an idle, live chat. Sleeping-chat CI/review delivery is not verified yet.',
    'Subscription expiry is not a wake. Before ending your turn, persist PR URL, full head SHA, pending check names/run URLs, ' +
      'subscription ID/expiry and a fallback deadline. Arrange one bounded fallback check using `create_project_schedule` ' +
      'with a message_session action targeting this same session; save its ID and confirm it was accepted. ' +
      'If unavailable or rejected, report the exact blocker to your coordinator instead of assuming expiry will resume you. ' +
      'On resume inspect subscriptions with state "any" and reconcile GitHub. Cancel only your obsolete subscriptions and fallback schedules. ' +
      'Renew only for checks still pending on the current full SHA, with a new idempotency key for a changed filter. ' +
      'After one fallback without progress, report exact pending checks/run URLs and delivery status; do not blindly renew the same wait. ' +
      'Say when you relied on the fallback; a stale continuation is not proof of a live wait.',
    input.coordinationChannel
      ? `Your feature coordination channel is \`${input.coordinationChannel}\`, shared with your coordinator and sibling agents; ` +
        '`dispatch_task` passes it to your subtasks automatically. Publish findings, interface decisions, blockers, dependency ' +
        'readiness and completion evidence there with `publish_channel_event`; read it with `get_channel_history` or follow it ' +
        'with `follow_event_channel`. When following to be woken, pass `minWakeIntervalSeconds` (for example 600) unless you ' +
        'must react to each message at once, so channel traffic wakes you at most that often.'
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
