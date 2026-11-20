/** Refuse an unobserved writer: Compose stop on a nonexistent project succeeds without action. */
import { type BoxContext, check, composeArgs, composeRunEnv } from './backup-lib';
import { assertOperatorExecution } from './operator-only';

export function requireRunningCelld(ctx: BoxContext): void {
  assertOperatorExecution();
  const result = check(
    ctx.run(
      'docker',
      composeArgs(ctx, ['ps', '--status', 'running', '--quiet', '--no-trunc', 'celld']),
      composeRunEnv(ctx)
    ),
    'verify running celld before backup'
  );
  const ids = result.stdout.trim().split(/\s+/);
  if (ids.length !== 1 || !/^[a-f0-9]{64}$/.test(ids[0] ?? '')) {
    throw new Error(
      'Backup refused: selected Compose project must have exactly one running celld container'
    );
  }
}
