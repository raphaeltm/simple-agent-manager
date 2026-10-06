/**
 * Default month length for normalizing provider prices between hourly and
 * monthly displays when the provider catalog does not publish both values.
 *
 * Callers that have a stricter billing policy should pass their configured
 * month length through provider/catalog normalization instead of relying on
 * this fallback.
 */
export const DEFAULT_APPROXIMATE_BILLING_MONTH_HOURS = 730;

export function resolveApproximateBillingMonthHours(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_APPROXIMATE_BILLING_MONTH_HOURS;
}
