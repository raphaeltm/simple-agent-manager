import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../env';

/**
 * Tombstones for the Durable Object classes of the retired anonymous-trial product.
 *
 * Wrangler migrations v7–v9 created `TrialCounter`, `TrialEventBus` and `TrialOrchestrator`.
 * Cloudflare rejects a deploy that stops exporting a class an existing namespace depends on
 * unless a `deleted_classes` migration is added, and that migration irreversibly deletes every
 * object's storage. Exporting these inert classes keeps upgrades deployable without destroying
 * anything, and clean installs simply create namespaces that nothing binds to.
 *
 * Nothing in the Worker binds or calls these namespaces any more. A stray request answers
 * 410 Gone, and an alarm left armed by an old orchestrator fires once and does nothing.
 */
class RetiredTrialDurableObject extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    return Response.json(
      { error: 'GONE', message: 'Anonymous trials have been retired.' },
      { status: 410 }
    );
  }

  async alarm(): Promise<void> {
    // Intentionally empty: do not re-arm, provision, or touch any resource.
  }
}

export class TrialCounter extends RetiredTrialDurableObject {}
export class TrialEventBus extends RetiredTrialDurableObject {}
export class TrialOrchestrator extends RetiredTrialDurableObject {}
