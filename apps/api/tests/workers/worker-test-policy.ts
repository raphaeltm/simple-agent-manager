const WORKER_RPC_REJECTION_PATTERNS = [
  /^Chat session [A-Za-z0-9_-]+ not found$/,
  /^Session [A-Za-z0-9_-]+ not found$/,
  /^Session [A-Za-z0-9_-]+ is stopped and cannot accept messages$/,
  /^Session message limit of [1-9][0-9]* messages exceeded$/,
  /^Mailbox message limit reached \([1-9][0-9]*\)$/,
  /^Invalid ACP session transition: [a-z_]+ → [a-z_]+ \(session [A-Za-z0-9_-]+\)$/,
  /^Node mismatch: session assigned to [A-Za-z0-9_-]+, heartbeat from [A-Za-z0-9_-]+$/,
  /^Cannot fork session in "[a-z_]+" state — must be completed, failed, or interrupted$/,
  /^node_lifecycle_conflict: node is being destroyed$/,
  /^node_lifecycle_not_found: no state stored$/,
] as const;

/**
 * workerd reports some caught DO RPC rejections a second time through the
 * Vitest harness. Suppress only the exact production messages asserted by the
 * worker suite and only when the error carries worker-RPC provenance.
 */
export function isExpectedWorkerTestRejection(error: Error): boolean {
  const stack = error.stack ?? '';
  const isWorkerRpcError =
    stack.includes('/tests/workers/') ||
    stack.includes('@cloudflare/vitest-pool-workers') ||
    (error as Error & { remote?: boolean }).remote === true;

  return (
    isWorkerRpcError && WORKER_RPC_REJECTION_PATTERNS.some((pattern) => pattern.test(error.message))
  );
}
