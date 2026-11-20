/** Keep cleanup identity stable after platform keys and finally installation state are removed. */
import { composeProjectFor, expectedComposeProjectFor } from './install-record';
import type { TeardownContext } from './teardown-box';

export function expectedTeardownProject(ctx: TeardownContext): string {
  return expectedComposeProjectFor(ctx.box, ctx.stateDir, ctx.installationId ?? undefined);
}
export function selectedTeardownProject(ctx: TeardownContext): string {
  return ctx.box.COMPOSE_PROJECT_NAME === undefined
    ? expectedTeardownProject(ctx)
    : composeProjectFor(ctx.box, ctx.stateDir);
}
