/**
 * The lease an agent email setup run holds on its attempt record (`./setup-state.ts`) while it
 * changes Cloudflare. One run at a time holds it. The run renews it right before every
 * Cloudflare write and stops if it lapsed, was taken over, or the renewal itself stalled, so a
 * stalled run sends nothing more once another run may have started. Only a run whose lease is
 * still live by the database's clock can turn agent email on.
 *
 * A write already sent cannot be called back. Each write goes out with at least half the lease
 * left, ten Cloudflare API timeouts, so another run can start before such a write lands only if
 * Cloudflare applied it minutes after it was sent.
 */
import type {
  AgentEmailMainDomainRecord,
  AgentEmailSetupPlan,
  AgentEmailZoneChange,
  MailDnsRecord,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { DEFAULT_CF_API_TIMEOUT_MS } from '../dns-core';
import { getTimeoutMs } from '../fetch-timeout';
import { allowedAdditions, toMailRecord } from './setup-changes';
import { AgentEmailSetupRefusedError } from './setup-errors';
import {
  type AgentEmailSetupAttempt,
  claimSetupAttempt,
  replaceSetupAttempt,
  type StoredSetupAttempt,
} from './setup-state';

/**
 * How long one renewal of the lease lasts: many Cloudflare API timeouts, so it cannot lapse
 * while one write is outstanding. Every exit releases it, so it lapses on its own only if the
 * Worker died mid-run.
 */
function setupLeaseMs(env: Env): number {
  return 20 * getTimeoutMs(env.CF_API_TIMEOUT_MS, DEFAULT_CF_API_TIMEOUT_MS);
}

function leaseHeld(attempt: AgentEmailSetupAttempt, now: number): boolean {
  return attempt.owner !== null && Date.parse(attempt.leaseUntil ?? '') > now;
}

/** What a run claims with: the plan the admin allowed and what the plan read. */
export interface SetupClaim {
  domain: string;
  mainDomain: string;
  state: AgentEmailSetupPlan['state'];
  mainDomainChanges: AgentEmailMainDomainRecord[];
  zoneChanges: AgentEmailZoneChange[];
  /** The main domain's MX and SPF records, read before this run changes anything. */
  mainDomainMail: MailDnsRecord[];
  existing: StoredSetupAttempt | null;
  refreshBaseline?: boolean;
  userId: string;
}

export class SetupLease {
  private constructor(
    private readonly env: Env,
    private owned: StoredSetupAttempt
  ) {}

  get attempt(): AgentEmailSetupAttempt {
    return this.owned.attempt;
  }

  /** The attempt exactly as stored, for the completing compare-and-set. */
  get stored(): StoredSetupAttempt {
    return this.owned;
  }

  /**
   * Stores the attempt and takes its lease before anything changes Cloudflare. A new attempt
   * keeps the baseline this run read; one left by an earlier run keeps its own, unless the
   * admin allowed the records as they are now (`changed`). Refuses while another run holds it.
   */
  static async claim(env: Env, claim: SetupClaim): Promise<SetupLease> {
    const now = Date.now();
    const lease = {
      owner: crypto.randomUUID(),
      leaseUntil: new Date(now + setupLeaseMs(env)).toISOString(),
    };
    const acceptedZoneChanges = claim.zoneChanges.map((change) => change.setting);
    if (!claim.existing) {
      const attempt: AgentEmailSetupAttempt = {
        domain: claim.domain,
        startedAt: new Date(now).toISOString(),
        startedBy: claim.userId,
        baseline: claim.mainDomainMail.map(toMailRecord),
        allowed: allowedAdditions(claim.mainDomainChanges, claim.mainDomain),
        removed: allowedAdditions(
          claim.mainDomainChanges
            .filter((change) => change.change === 'remove')
            .map((change) => ({ ...change, change: 'add' as const })),
          claim.mainDomain
        ),
        zoneChanges: acceptedZoneChanges,
        ...lease,
      };
      const stored = await claimSetupAttempt(env, attempt);
      if (stored.attempt.owner !== lease.owner) {
        throw new AgentEmailSetupRefusedError(
          'Another agent email setup run started at the same time. Check again.'
        );
      }
      return new SetupLease(env, stored);
    }
    const previous = claim.existing.attempt;
    if (leaseHeld(previous, now)) {
      throw new AgentEmailSetupRefusedError(
        'Another agent email setup run is in progress. Check again in a few minutes.'
      );
    }
    const next: AgentEmailSetupAttempt = {
      ...previous,
      ...(claim.state === 'changed'
        ? { baseline: claim.mainDomainMail.map(toMailRecord), allowed: [], removed: [] }
        : {}),
      ...(claim.refreshBaseline
        ? {
            baseline: claim.mainDomainMail.map(toMailRecord),
            allowed: allowedAdditions(claim.mainDomainChanges, claim.mainDomain),
            removed: allowedAdditions(
              claim.mainDomainChanges
                .filter((change) => change.change === 'remove')
                .map((change) => ({ ...change, change: 'add' as const })),
              claim.mainDomain
            ),
          }
        : {}),
      zoneChanges: [...new Set([...previous.zoneChanges, ...acceptedZoneChanges])],
      ...lease,
    };
    if (!(await replaceSetupAttempt(env, claim.existing, next))) {
      throw new AgentEmailSetupRefusedError(
        'Another agent email setup run changed the setup at the same time. Check again.'
      );
    }
    return new SetupLease(env, { attempt: next, stored: JSON.stringify(next) });
  }

  /** Call right before every Cloudflare write: extends the lease, or stops the run. */
  async renew(): Promise<void> {
    const now = Date.now();
    if (Date.parse(this.owned.attempt.leaseUntil ?? '') <= now) {
      throw new AgentEmailSetupRefusedError(
        'This agent email setup run outlasted its lease, so another run may have started. Check again.'
      );
    }
    const leaseMs = setupLeaseMs(this.env);
    const next = { ...this.owned.attempt, leaseUntil: new Date(now + leaseMs).toISOString() };
    if (!(await replaceSetupAttempt(this.env, this.owned, next))) {
      throw new AgentEmailSetupRefusedError(
        'Another agent email setup run took over before this one finished. Check again.'
      );
    }
    this.owned = { attempt: next, stored: JSON.stringify(next) };
    // The new lease counts from before the write that stored it. If that write was slow, the
    // Cloudflare change that follows would go out with little of the lease left.
    if (Date.parse(next.leaseUntil) - Date.now() < leaseMs / 2) {
      throw new AgentEmailSetupRefusedError(
        'This agent email setup run stalled while renewing its lease, so it stopped before its next Cloudflare change. Check again.'
      );
    }
  }

  /** Gives the lease back, keeping the baseline. A run that lost the lease has nothing to give. */
  async release(): Promise<void> {
    try {
      await replaceSetupAttempt(this.env, this.owned, {
        ...this.owned.attempt,
        owner: null,
        leaseUntil: null,
      });
    } catch (error) {
      log.error('agent_email.setup_lease_release_failed', {
        domain: this.owned.attempt.domain,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
