// Moved to @simple-agent-manager/project-data (worker modularization W1). Re-exported so the
// worker's existing importers are unchanged.
export {
  AGENT_WAKE_POLICY_MODES,
  type AgentWakeActorAccess,
  type AgentWakeDecision,
  type AgentWakeDenial,
  type AgentWakeGrant,
  type AgentWakePolicyMode,
  agentWakeRecord,
  type AgentWakeRequest,
  type AgentWakeTrigger,
  decideAgentWake,
  DEFAULT_AGENT_WAKE_POLICY_MODE,
  HUMAN_AGENT_WAKE_TRIGGERS,
  HUMAN_PROMPT_DELIVERY_TRIGGERS,
  type HumanPromptDeliveryTrigger,
  isHumanPromptDeliveryTrigger,
} from '@simple-agent-manager/project-data';
