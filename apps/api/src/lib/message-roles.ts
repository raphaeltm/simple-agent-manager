export const VALID_MESSAGE_ROLES = [
  'user',
  'assistant',
  'system',
  'tool',
  'thinking',
  'plan',
] as const;
export type MessageRole = (typeof VALID_MESSAGE_ROLES)[number];

/** Validate message role filters and deduplicate valid roles before SQL binding. */
export function validateRoles(
  input: unknown,
  defaultRoles: MessageRole[] = ['user', 'assistant']
): { valid: true; roles: MessageRole[] } | { valid: false; invalid: string[] } {
  if (!Array.isArray(input)) return { valid: true, roles: defaultRoles };
  const strings = input.filter((role): role is string => typeof role === 'string');
  const invalid = strings.filter(
    (role) => !(VALID_MESSAGE_ROLES as readonly string[]).includes(role)
  );
  if (invalid.length > 0) return { valid: false, invalid };
  const roles = strings.length > 0 ? ([...new Set(strings)] as MessageRole[]) : defaultRoles;
  return { valid: true, roles };
}
