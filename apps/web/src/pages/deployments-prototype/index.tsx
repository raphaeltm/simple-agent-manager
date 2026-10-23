/**
 * PROTOTYPE entry points: the real Deployments routes render these when `?take=` is set
 * in a dev build (see `take.ts`). Never merge to main.
 */
import { EnvironmentDetailA } from './take-a/DetailA';
import { DeploymentsListA } from './take-a/ListA';
import type { Take } from './take';

export { useTake } from './take';

export function DeploymentsPrototypeList({ take }: { take: Take }) {
  return take === 'a' ? <DeploymentsListA /> : <DeploymentsListA />;
}

export function DeploymentsPrototypeDetail({ take }: { take: Take }) {
  return take === 'a' ? <EnvironmentDetailA /> : <EnvironmentDetailA />;
}
