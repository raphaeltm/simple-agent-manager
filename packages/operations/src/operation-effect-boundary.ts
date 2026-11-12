/** Trusted in-process evidence that an operation rejected before task effects began.
 * Keep the original error identity/status for REST callers; never trust HTTP status
 * or a serializable error property as evidence that a write is safe to retry. */
const rejectedBeforeEffects = new WeakSet<Error>();

export function markRejectedBeforeEffects<T extends Error>(error: T): T {
  rejectedBeforeEffects.add(error);
  return error;
}

export function takeRejectedBeforeEffects(error: unknown): error is Error {
  return error instanceof Error && rejectedBeforeEffects.delete(error);
}
