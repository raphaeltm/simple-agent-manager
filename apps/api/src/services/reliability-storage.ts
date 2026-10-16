/** Unix seconds; absent means bridge mode. Invalid configuration fails closed. */
export function storageCutover(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  if (!/^\d+$/.test(value)) throw new Error('Invalid reliability storage cutover');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error('Invalid reliability storage cutover');
  return parsed;
}
