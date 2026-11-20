/** Policy observations are exact and sanitized; an already absent grant is retry completion. */
import { check } from './backup-lib';
import type { TeardownContext } from './teardown-box';

export function cloudMetadata(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Refused: unreadable Google Cloud ownership metadata');
  }
}
export function grantPresent(
  ctx: TeardownContext,
  args: string[],
  role: string,
  member: string
): boolean {
  let result;
  try {
    result = ctx.run('gcloud', [...args, '--format=json']);
  } catch {
    throw new Error('Cannot read recorded IAM grant policy');
  }
  const value = cloudMetadata(check(result, 'read recorded IAM grant policy').stdout);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Refused: unreadable IAM grant policy');
  const bindings = (value as { bindings?: unknown }).bindings ?? [];
  if (
    !Array.isArray(bindings) ||
    bindings.some(
      (b) =>
        !b ||
        typeof b.role !== 'string' ||
        !Array.isArray(b.members) ||
        b.members.some((m: unknown) => typeof m !== 'string')
    )
  )
    throw new Error('Refused: unreadable IAM grant policy');
  const matching = bindings.filter((b) => b.role === role && b.members.includes(member));
  if (matching.some((b) => b.condition))
    throw new Error('Refused: recorded IAM grant is now conditional');
  return matching.length > 0;
}
