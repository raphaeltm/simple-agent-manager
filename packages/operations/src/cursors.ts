import { OperationError } from './errors';

export function readOperationCursor(value?: string): { updatedAt: string; id: string } | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== 'string' ||
      typeof parsed[1] !== 'string' ||
      !parsed[1]
    )
      throw new Error('Invalid cursor');
    return { updatedAt: parsed[0], id: parsed[1] };
  } catch {
    throw new OperationError('invalid_input', 'Invalid pagination cursor');
  }
}
export function formatOperationCursor(row: { updatedAt: string; id: string }): string {
  return JSON.stringify([row.updatedAt, row.id]);
}
