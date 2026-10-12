import { NodeAgentHttpError } from './node-agent';

/** A superseded attempt must end, rather than retry against its successor. */
export class SessionSleepRuntimeChangedError extends Error {
  constructor() {
    super('Workspace sleep runtime identity changed; the replacement runtime was left alone');
    this.name = 'SessionSleepRuntimeChangedError';
  }
}

export function sessionSleepRuntimeChanged(error: unknown): boolean {
  if (error instanceof SessionSleepRuntimeChangedError) return true;
  if (!(error instanceof NodeAgentHttpError) || error.statusCode !== 409) return false;
  try {
    const body: unknown = JSON.parse(error.responseBody);
    if (!body || typeof body !== 'object') return false;
    const response = body as { message?: unknown; error?: unknown };
    return response.message === 'workspace eviction generation changed' ||
      response.error === 'workspace eviction generation changed';
  } catch {
    return false;
  }
}
