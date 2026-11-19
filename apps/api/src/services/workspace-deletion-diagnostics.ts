/**
 * Bounded, credential-scrubbed diagnostics for workspace deletion attempts. The persisted
 * diagnostic is a category only; the internal error name and message go to logs, so a
 * `request_failed` retry loop is diagnosable without persisting a node agent's response body.
 */
import { DEFAULT_WORKSPACE_DELETION_DIAGNOSTIC_MAX_LENGTH } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { NodeAgentHttpError } from './node-agent';

export const WORKSPACE_DELETION_DIAGNOSTIC_PREFIX = 'Workspace deletion unconfirmed';

function diagnosticMaxLength(env: Env): number {
  const parsed = Number.parseInt(env.WORKSPACE_DELETION_DIAGNOSTIC_MAX_LENGTH ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_WORKSPACE_DELETION_DIAGNOSTIC_MAX_LENGTH;
}

export function boundedDiagnostic(env: Env, value: string): string {
  const sanitized = value
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(token|secret|password)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized.slice(0, diagnosticMaxLength(env));
}

export function deletionFailureDiagnostic(env: Env, attempt: number, error: unknown): string {
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  const message = error instanceof Error ? error.message : String(error);
  const statusMatch = /(?:HTTP|status)\s+(\d{3})/i.exec(message);
  let category = 'request_failed';
  if (
    error instanceof NodeAgentHttpError &&
    Number.isInteger(error.statusCode) &&
    error.statusCode >= 100 &&
    error.statusCode <= 599
  ) {
    // The typed boundary supplies the status; never inspect or persist its raw
    // response body (which may contain credentials or misleading timeout text).
    category = `http_status_${error.statusCode}`;
  } else if (/timeout|timed out|abort/i.test(`${errorName} ${message}`)) {
    category = 'request_timeout';
  } else if (statusMatch?.[1]) {
    category = `http_status_${statusMatch[1]}`;
  }
  return boundedDiagnostic(
    env,
    `${WORKSPACE_DELETION_DIAGNOSTIC_PREFIX}: VM attempt ${attempt} (${errorName}: ${category})`
  );
}

/** Log-only fields naming the throw site; never a node agent's response body. */
export function deletionFailureLogFields(
  env: Env,
  error: unknown
): { errorName: string; errorMessage?: string } {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage:
      error instanceof NodeAgentHttpError
        ? undefined
        : boundedDiagnostic(env, error instanceof Error ? error.message : String(error)),
  };
}
