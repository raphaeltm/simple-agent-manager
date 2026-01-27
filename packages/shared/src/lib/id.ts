const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 6;

/**
 * Generate a workspace ID
 * Format: ws-{random6}
 * Example: ws-abc123
 */
export function generateWorkspaceId(): string {
  const random = Array.from({ length: ID_LENGTH }, () =>
    CHARS[Math.floor(Math.random() * CHARS.length)]
  ).join('');
  return `ws-${random}`;
}

/**
 * Validate a workspace ID format
 */
export function isValidWorkspaceId(id: string): boolean {
  return /^ws-[a-z0-9]{6}$/.test(id);
}

/**
 * Extract the random portion from a workspace ID
 */
export function extractWorkspaceIdSuffix(id: string): string | null {
  const match = id.match(/^ws-([a-z0-9]{6})$/);
  return match?.[1] ?? null;
}
