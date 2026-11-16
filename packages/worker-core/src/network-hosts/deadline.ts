/** Branch-only whole-operation deadline adapter around the canonical outbound guard. */
import { guardedFetch, type OutboundPolicy } from './guarded-fetch';

export class OutboundDeadlineError extends Error {
  constructor() {
    super('Outbound request deadline exceeded');
    this.name = 'OutboundDeadlineError';
  }
}

interface OperationSignal {
  signal: AbortSignal | undefined;
  /** Stops the deadline once the final response is in hand, so the body is never cut by it. */
  settle: () => void;
  expired: () => boolean;
}

/** A signal that aborts on the caller's signal or when `deadlineMs` passes. */
function operationSignal(
  callerSignal: AbortSignal | null | undefined,
  deadlineMs: number | undefined
): OperationSignal {
  if (deadlineMs === undefined) {
    return { signal: callerSignal ?? undefined, settle: () => undefined, expired: () => false };
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('Outbound request deadline exceeded', 'TimeoutError'));
  }, deadlineMs);
  const forward = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) forward();
  else callerSignal?.addEventListener('abort', forward, { once: true });
  // The caller's signal stays linked after settle: it may still cancel the final body.
  return { signal: controller.signal, settle: () => clearTimeout(timer), expired: () => timedOut };
}

export async function guardedFetchWithDeadline(
  input: string | URL,
  init: RequestInit = {},
  policy: OutboundPolicy & { deadlineMs?: number } = {}
): Promise<Response> {
  const operation = operationSignal(init.signal, policy.deadlineMs);
  try {
    return await guardedFetch(input, { ...init, signal: operation.signal }, policy);
  } catch (error) {
    if (operation.expired()) throw new OutboundDeadlineError();
    throw error;
  } finally {
    operation.settle();
  }
}
