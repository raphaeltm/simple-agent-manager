/** The durable task/session boundary created for one trigger execution. */
export interface SubmittedTriggerTask {
  taskId: string;
  sessionId: string;
  branchName: string;
}

/** The task exists, but TaskRunner startup could not yet be confirmed. */
export class TriggerTaskSubmissionPendingError extends Error {
  readonly submission: SubmittedTriggerTask;

  constructor(submission: SubmittedTriggerTask) {
    super('Task runner startup confirmation is pending');
    this.name = 'TriggerTaskSubmissionPendingError';
    this.submission = submission;
  }
}
