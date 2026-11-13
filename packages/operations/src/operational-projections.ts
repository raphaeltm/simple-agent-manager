/** Allowlisted evidence only. Never return remote error text, commands, prompts or logs. */
export function diagnostic(present: unknown, code: string) {
  if (!present) return null;
  const text = typeof present === 'string' ? present : '';
  const category = /usage.limit|rate.limit|quota|credit|budget/i.test(text)
    ? 'provider_limit'
    : /disconnect|unreachable|connection|transport/i.test(text)
      ? 'runtime_connection'
      : /permission|approval|authorization/i.test(text)
        ? 'authorization_or_human_input'
        : /boot|provision|startup/i.test(text)
          ? 'startup'
          : /cleanup|delet|teardown/i.test(text)
            ? 'cleanup'
            : 'unspecified';
  return { code, category, detail: 'Details withheld; inspect the authorized SAM UI' };
}
export function deliveryProjection(m: Record<string, unknown>) {
  return {
    deliveryId: m.id,
    chatSessionId: m.targetSessionId,
    messageId: m.promptMessageId,
    state: m.deliveryState,
    attempts: m.deliveryAttempts,
    createdAt: m.createdAt,
    deliveredAt: m.deliveredAt,
    ackedAt: m.ackedAt,
    acceptedAt: m.acceptedAt,
    nextAttemptAt: m.nextAttemptAt,
    expiresAt: m.expiresAt,
    error: diagnostic(m.lastError, 'DELIVERY_ERROR'),
    terminal: m.terminalReason ? { present: true } : null,
    receipt: {
      supported: m.receiptSupported,
      state: m.receiptState,
      checkedAt: m.receiptCheckedAt,
    },
    consumption: 'unknown',
  };
}
export function interactionProjection(m: Record<string, unknown>) {
  // SafeSummary is itself allowlisted; do not echo new fields added to it later.
  return Object.fromEntries(
    [
      'interactionId',
      'kind',
      'state',
      'createdAt',
      'updatedAt',
      'deadlineAt',
      'answeredAt',
      'urlCompletedAt',
      'deliveryState',
    ].map((key) => [key, m[key] ?? null])
  );
}
