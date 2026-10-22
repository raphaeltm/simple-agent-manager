/**
 * A refusal or failure of an agent model call, named by what the agent (or a person) should do
 * next (rule 72): fix the input, ask someone to enable the model or raise the budget, or retry.
 */
export type AgentModelCallErrorCode =
  | 'disabled'
  | 'unknown_model'
  | 'unsupported_model'
  | 'not_enabled'
  | 'budget_exhausted'
  | 'invalid_input'
  | 'input_too_large'
  | 'workspace_required'
  | 'catalog_unavailable'
  | 'upstream_error'
  | 'timeout';

export class AgentModelCallError extends Error {
  constructor(
    readonly code: AgentModelCallErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'AgentModelCallError';
  }
}
