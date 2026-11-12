/** Current-generation runtime tool activity can outlive an ACP prompt's wall-clock ceiling. */
export function freshRuntimeWorkProgressAt(
  state: {
    runtimeWorkState: unknown;
    runtimeWorkProgressAt: unknown;
    runtimeWorkUpdatedAt: unknown;
  },
  now: number,
  maxSilenceMs: number,
  after = 0
): number | null {
  if (state.runtimeWorkState !== 'active' && state.runtimeWorkState !== 'settling') return null;
  const fresh = [state.runtimeWorkProgressAt, state.runtimeWorkUpdatedAt].filter(
    (value): value is number =>
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value > after &&
      now - value >= 0 &&
      now - value < maxSilenceMs
  );
  return fresh.length > 0 ? Math.max(...fresh) : null;
}
