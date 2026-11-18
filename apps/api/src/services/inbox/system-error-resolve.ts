/**
 * Close a recovered thing's system error inbox item (slice E). Kept apart from
 * `system-errors.ts`, which builds operation ports: the retry tools and the wake signal call this
 * from modules that the ports themselves import, and must not pull that graph back in.
 */
import { resolveSystemError } from '@simple-agent-manager/operations';

import type { Env } from '../../env';

/** Never throws. */
export function resolveSystemErrorFor(
  env: Env,
  input: Parameters<typeof resolveSystemError>[1]
): Promise<number> {
  return resolveSystemError({ env }, input);
}
