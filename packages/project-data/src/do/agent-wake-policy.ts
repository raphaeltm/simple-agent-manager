/**
 * The one decision for "may this human cause this agent session to be prompted?".
 *
 * Every human-originated agent wake asks this function: the Send-to-agent route
 * (`routes/chat-comments.ts`), a typed or connector message (`services/send-chat.ts`
 * `authorizeSendChat`), an answer to the agent's attention request, which is sent to the
 * agent as a new prompt (`routes/chat-attention.ts` `answerAttention`), and the
 * delivery-time fence that re-checks a queued prompt just before it reaches the agent
 * (`project-data/session-access-expiry.ts` `senderLacksSessionAccess`). A future
 * human-task comment wake must call it too.
 *
 * Not a wake, so not asked: answering an ACP permission or question request
 * (`routes/chat-acp-interactions.ts`). That replies inside a turn the agent already started
 * and is blocked on; it never starts agent work. It still requires a session writer.
 *
 * The decision is pure: callers resolve the actor's session access (owner, active grantee,
 * none) and pass it in. The API side also checks that a grantee and the owner are still
 * project members (`requireSessionWriter`) before asking.
 *
 * Mode `trusted_project` is today's behaviour, and the only mode: everyone in a shared
 * project knows and trusts each other, so a session's writers (its owner, and anyone the
 * owner shared it with) may wake its agent, and nobody else may.
 *
 * How a stricter mode plugs in (not built; no UI):
 * - `session_owner_only`: add the member to `AGENT_WAKE_POLICY_MODES` and a `case` below
 *   that denies `grantee`. Select it per project from a project setting resolved by the
 *   API caller and passed as `mode`; the DO fence would read the same setting from the
 *   delivery's recorded `wake.mode`, so a prompt is judged by the rule it was queued under.
 * - `assignee_only` (human tasks): add a trigger kind carrying the task's assignee and
 *   claimer, and allow only those people plus session writers. The trigger, not the mode,
 *   carries what the rule needs, so existing triggers are unaffected.
 */

/**
 * Durable prompt sources a human originates. The delivery fence re-asks the policy for these
 * just before delivery, using the source kind as the trigger.
 */
export const HUMAN_PROMPT_DELIVERY_TRIGGERS = ['user_followup', 'comment_directive'] as const;
/** Every human action that starts agent work. */
export const HUMAN_AGENT_WAKE_TRIGGERS = [
  ...HUMAN_PROMPT_DELIVERY_TRIGGERS,
  'attention_answer',
] as const;
export type AgentWakeTrigger = (typeof HUMAN_AGENT_WAKE_TRIGGERS)[number];
export type HumanPromptDeliveryTrigger = (typeof HUMAN_PROMPT_DELIVERY_TRIGGERS)[number];

export const AGENT_WAKE_POLICY_MODES = ['trusted_project'] as const;
export type AgentWakePolicyMode = (typeof AGENT_WAKE_POLICY_MODES)[number];
export const DEFAULT_AGENT_WAKE_POLICY_MODE: AgentWakePolicyMode = 'trusted_project';

export function isHumanPromptDeliveryTrigger(value: string): value is HumanPromptDeliveryTrigger {
  return (HUMAN_PROMPT_DELIVERY_TRIGGERS as readonly string[]).includes(value);
}

/** The actor's access to the target session, as the session-access resolver reports it. */
export interface AgentWakeActorAccess {
  role: 'owner' | 'grantee' | 'none';
  /** The session owner (`chat_sessions.created_by_user_id`). */
  ownerUserId: string | null;
  /** The actor's own active grant, when they are a grantee. */
  grantId: string | null;
}

export interface AgentWakeRequest {
  mode?: AgentWakePolicyMode;
  trigger: AgentWakeTrigger;
  sessionId: string;
  actorUserId: string;
  access: AgentWakeActorAccess;
}

export interface AgentWakeGrant {
  allowed: true;
  mode: AgentWakePolicyMode;
  trigger: AgentWakeTrigger;
  sessionId: string;
  /** The person causing the wake. Attribution only. */
  actorUserId: string;
  /** The session owner whose agent, workspace and credentials run the prompt. */
  onBehalfOfUserId: string;
  actorRole: 'owner' | 'grantee';
  grantId: string | null;
  /** True when someone other than the owner caused it: the prompt is teammate input. */
  teammateInput: boolean;
}

export interface AgentWakeDenial {
  allowed: false;
  mode: AgentWakePolicyMode;
  trigger: AgentWakeTrigger;
  reason: 'not_session_writer';
}

export type AgentWakeDecision = AgentWakeGrant | AgentWakeDenial;

export function decideAgentWake(request: AgentWakeRequest): AgentWakeDecision {
  const mode = request.mode ?? DEFAULT_AGENT_WAKE_POLICY_MODE;
  const { access } = request;
  const deny: AgentWakeDenial = {
    allowed: false,
    mode,
    trigger: request.trigger,
    reason: 'not_session_writer',
  };
  switch (mode) {
    case 'trusted_project': {
      if (!access.ownerUserId) return deny;
      if (access.role === 'owner') {
        return grant(request, mode, access.ownerUserId, 'owner', null);
      }
      if (access.role === 'grantee' && access.grantId) {
        return grant(request, mode, access.ownerUserId, 'grantee', access.grantId);
      }
      return deny;
    }
  }
}

function grant(
  request: AgentWakeRequest,
  mode: AgentWakePolicyMode,
  ownerUserId: string,
  actorRole: 'owner' | 'grantee',
  grantId: string | null
): AgentWakeGrant {
  return {
    allowed: true,
    mode,
    trigger: request.trigger,
    sessionId: request.sessionId,
    actorUserId: request.actorUserId,
    onBehalfOfUserId: ownerUserId,
    actorRole,
    grantId,
    teammateInput: request.actorUserId !== ownerUserId,
  };
}

/**
 * What every agent wake records about who woke the agent and for whom: under
 * `metadata.wake` on a queued prompt delivery, or on the `session.shared_answer` activity
 * event for a teammate's attention answer, which bypasses the queue. Server-written only; the existing `userId` / `onBehalfOfUserId` /
 * `grantId` keys keep their meaning for the transcript and revocation paths.
 */
export function agentWakeRecord(wake: AgentWakeGrant): Record<string, unknown> {
  return {
    trigger: wake.trigger,
    policyMode: wake.mode,
    triggeredByUserId: wake.actorUserId,
    onBehalfOfUserId: wake.onBehalfOfUserId,
    actorRole: wake.actorRole,
    teammateInput: wake.teammateInput,
    grantId: wake.grantId,
  };
}
