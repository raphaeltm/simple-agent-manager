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
  const policy = value as { bindings?: unknown };
  const bindings = policy.bindings === undefined ? [] : policy.bindings;
  if (
    !Array.isArray(bindings) ||
    bindings.some(
      (b) =>
        !b ||
        typeof b.role !== 'string' ||
        !Array.isArray(b.members) ||
        b.members.some((m: unknown) => typeof m !== 'string') ||
        (b.condition !== undefined &&
          (!b.condition ||
            typeof b.condition !== 'object' ||
            Array.isArray(b.condition) ||
            typeof b.condition.expression !== 'string'))
    )
  )
    throw new Error('Refused: unreadable IAM grant policy');
  return bindings.some(
    (b) => b.condition === undefined && b.role === role && b.members.includes(member)
  );
}
