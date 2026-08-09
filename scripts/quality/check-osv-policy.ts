export interface OsvIgnoreEntry {
  id: string;
  reason?: string;
  expires?: string;
}

export interface OsvPolicyInput {
  eventName: string;
  schedule?: string;
  hasPrivateBacklogRouting: boolean;
  ignores: OsvIgnoreEntry[];
}

export interface OsvPolicyResult {
  ok: boolean;
  errors: string[];
  advisoryRun: boolean;
}

function isFutureIsoDate(value: string, now: Date): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > now.getTime();
}

export function validateOsvPolicy(input: OsvPolicyInput, now = new Date()): OsvPolicyResult {
  const errors: string[] = [];
  const advisoryRun = input.eventName === 'schedule' || input.eventName === 'workflow_dispatch';

  if (input.eventName === 'pull_request') {
    return { ok: true, errors: [], advisoryRun: false };
  }

  if (!advisoryRun) {
    errors.push(`Unsupported OSV policy event: ${input.eventName}`);
  }

  if (advisoryRun && !input.hasPrivateBacklogRouting) {
    errors.push('Scheduled OSV advisory follow-up requires private SAM/backlog routing.');
  }

  for (const ignore of input.ignores) {
    if (!ignore.id.trim()) errors.push('Every OSV ignore requires an advisory id.');
    if (!ignore.reason?.trim())
      errors.push(`OSV ignore ${ignore.id || '<missing>'} requires a reason.`);
    if (!ignore.expires || !isFutureIsoDate(ignore.expires, now)) {
      errors.push(`OSV ignore ${ignore.id || '<missing>'} requires a future expiry.`);
    }
  }

  return { ok: errors.length === 0, errors, advisoryRun };
}
