/** Errors the agent email admin setup reports to the admin (`409` in the setup routes). */

/** The setup cannot run in its current state; the message says why and what to do. */
export class AgentEmailSetupRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentEmailSetupRefusedError';
  }
}

/** Turning routing on left the main domain's mail records different from what was shown. */
export class AgentEmailMainDomainChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentEmailMainDomainChangedError';
  }
}
