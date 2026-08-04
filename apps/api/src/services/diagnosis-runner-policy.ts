import { redactSensitiveData } from './observability';

export function safeDiagnosisMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return String(redactSensitiveData(raw)).slice(0, 500);
}

export function classifyDiagnosisFailure(error: unknown): { transient: boolean; code: string } {
  const message = safeDiagnosisMessage(error).toLowerCase();
  if (/429|5\d\d|timeout|timed out|abort|temporar|unavailable|network/.test(message)) {
    return { transient: true, code: 'TRANSIENT_UPSTREAM' };
  }
  return { transient: false, code: 'PERMANENT_EXECUTION' };
}

export function diagnosisRetryDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
}
