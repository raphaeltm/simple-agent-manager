/**
 * Proof that a provider create failed before its create request was sent.
 *
 * A durable allocation records "a create may exist" before calling `createVM`, and from then
 * on only reconciles (apps/api `node-allocation-recovery.ts`). A provider whose createVM does
 * network work before the create request (GCP: OAuth token exchange, firewall ensure) marks a
 * failure in that stretch, so the durable owner can clear its record and create again instead
 * of reconciling an inventory that can never contain the VM. Unmarked errors stay uncertain.
 */
const CREATE_NOT_DISPATCHED = Symbol.for('sam.provider.createNotDispatched');

/** Mark `err` as thrown before the provider's create request was sent. Returns `err`. */
export function markProviderCreateNotDispatched<T>(err: T): T {
  if (typeof err === 'object' && err !== null) {
    Object.defineProperty(err, CREATE_NOT_DISPATCHED, { value: true, enumerable: false });
  }
  return err;
}

/** True only when the provider proved its create request was never sent. */
export function isProviderCreateNotDispatched(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as Record<symbol, unknown>)[CREATE_NOT_DISPATCHED] === true
  );
}
