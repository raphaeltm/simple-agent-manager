const CANONICAL_SORT_LOCALE = 'en';

const CANONICAL_SORT_OPTIONS: Intl.CollatorOptions = {
  caseFirst: 'false',
  numeric: false,
  sensitivity: 'variant',
  usage: 'sort',
};

/** Compare persisted identifiers and paths independently of the host's default locale. */
export function compareCanonicalStrings(left: string, right: string): number {
  const localeOrder = left.localeCompare(right, CANONICAL_SORT_LOCALE, CANONICAL_SORT_OPTIONS);
  if (localeOrder !== 0) return localeOrder;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
