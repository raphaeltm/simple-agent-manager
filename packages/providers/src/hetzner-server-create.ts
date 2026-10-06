/**
 * Hetzner server creation for `HetznerProvider.createVM`: the capacity-retry loop and the
 * placement fallback it wraps.
 *
 * Split out of `hetzner.ts` (rule 18). Pure code motion: `createVM` still resolves and validates
 * the config, then delegates here; the loop and method bodies are unchanged.
 */
import { DEFAULT_HETZNER_IMAGE } from '@simple-agent-manager/shared';

import {
  HETZNER_API_URL,
  HETZNER_LOCATIONS,
  isHetznerPlacementCapacityError,
  isTransientCapacityError,
  mapHetznerProviderError,
  mapHetznerServerToVMInstance,
} from './hetzner-metadata';
import type { ResolvedNativeVMConfig } from './native-vm-config';
import {
  providerDelay,
  providerFetch,
  rethrowIfProviderRequestAborted,
  throwIfProviderRequestAborted,
} from './provider-fetch';
import type { ProviderLogger, ProviderRequestContext, VMInstance } from './types';
import { ProviderError } from './types';
import { parseProviderJson, validateHetznerServerResponse } from './validation';

/** Retry tuning resolved by `HetznerProvider`'s constructor, defaults already applied. */
export interface HetznerServerCreateOptions {
  placementRetryDelayMs: number;
  capacityRetryInitialDelayMs: number;
  capacityRetryMaxDelayMs: number;
  capacityRetryMaxAttempts: number;
  capacityRetryBudgetMs: number;
  logger: ProviderLogger;
}

export class HetznerServerCreate {
  readonly name = 'hetzner';
  private readonly placementRetryDelayMs: number;
  private readonly capacityRetryInitialDelayMs: number;
  private readonly capacityRetryMaxDelayMs: number;
  private readonly capacityRetryMaxAttempts: number;
  private readonly capacityRetryBudgetMs: number;
  private readonly logger: ProviderLogger;

  constructor(
    private readonly apiToken: string,
    options: HetznerServerCreateOptions
  ) {
    this.placementRetryDelayMs = options.placementRetryDelayMs;
    this.capacityRetryInitialDelayMs = options.capacityRetryInitialDelayMs;
    this.capacityRetryMaxDelayMs = options.capacityRetryMaxDelayMs;
    this.capacityRetryMaxAttempts = options.capacityRetryMaxAttempts;
    this.capacityRetryBudgetMs = options.capacityRetryBudgetMs;
    this.logger = options.logger;
  }

  async create(
    nativeConfig: ResolvedNativeVMConfig,
    allowLocationFallback: boolean,
    context?: ProviderRequestContext
  ): Promise<VMInstance> {
    const deadline = Date.now() + this.capacityRetryBudgetMs;
    let lastCapacityError: ProviderError | undefined;

    try {
      for (
        let capacityAttempt = 0;
        capacityAttempt < this.capacityRetryMaxAttempts;
        capacityAttempt++
      ) {
        try {
          return await this.attemptCreateWithPlacementFallback(
            nativeConfig,
            allowLocationFallback,
            context
          );
        } catch (err) {
          lastCapacityError = await this.retryAfterCapacityError(
            err,
            capacityAttempt,
            deadline,
            nativeConfig,
            context
          );
        }
      }
    } catch (err) {
      rethrowIfProviderRequestAborted(err, context);
      // `providerFetch` builds every HTTP error with category 'unknown'. Categorize it here, where
      // it leaves the provider, so the control plane reads `category` rather than re-running a
      // classifier behind a status allowlist (`.claude/rules/72`). This is what lets a
      // `403 resource_limit_exceeded` reach callers as `quota_exceeded` — proof the create was
      // rejected before any server existed — instead of an unexplained 'unknown'. It runs after
      // the retry loop above, so that loop's own decisions are unchanged.
      throw mapHetznerProviderError(err);
    }

    // Unreachable, but TypeScript needs it
    throw new ProviderError(this.name, undefined, 'Capacity retry loop exited unexpectedly', {
      cause: lastCapacityError,
    });
  }

  private async retryAfterCapacityError(
    error: unknown,
    attempt: number,
    deadline: number,
    config: ResolvedNativeVMConfig,
    context?: ProviderRequestContext
  ): Promise<ProviderError> {
    rethrowIfProviderRequestAborted(error, context);
    if (!(error instanceof ProviderError) || !isTransientCapacityError(error)) throw error;
    // A placement failure is transient capacity for the CONTROL PLANE (it should try another
    // offering from the pool) but not for THIS loop, which would spend the whole
    // `capacityRetryBudgetMs` re-asking for the same server type in the same location. Surface it
    // immediately so the pool's fallback chain descends. `attemptCreateWithPlacementFallback` has
    // already retried the primary location twice. See `.claude/rules/67`.
    if (isHetznerPlacementCapacityError(error)) throw error;

    const delay = this.computeCapacityRetryDelay(attempt);
    const isLastAttempt = attempt >= this.capacityRetryMaxAttempts - 1;
    const wouldExceedBudget = Date.now() + delay > deadline;
    if (isLastAttempt || wouldExceedBudget) {
      throw new ProviderError(
        this.name,
        422,
        `Capacity exhausted after ${attempt + 1} attempts for ` +
          `server type ${config.instanceType} in ${config.location}: ` +
          error.message,
        { cause: error, providerCode: error.providerCode, category: 'transient_capacity' }
      );
    }

    this.logger.warn('hetzner transient capacity error; retrying createVM', {
      delayMs: delay,
      attempt: attempt + 1,
      maxAttempts: this.capacityRetryMaxAttempts,
      budgetRemainingMs: Math.max(0, deadline - Date.now()),
      serverType: config.instanceType,
      location: config.location,
      statusCode: error.statusCode,
      providerCode: error.providerCode,
    });
    await providerDelay(delay, context);
    return error;
  }

  /**
   * Compute exponential backoff delay for capacity retries.
   * delay = min(initialDelay * 2^attempt, maxDelay)
   */
  private computeCapacityRetryDelay(attempt: number): number {
    const delay = this.capacityRetryInitialDelayMs * Math.pow(2, attempt);
    return Math.min(delay, this.capacityRetryMaxDelayMs);
  }

  /**
   * Inner placement loop: tries the primary location (twice with a delay),
   * then falls back to other locations on 412 placement errors.
   */
  private async attemptCreateWithPlacementFallback(
    config: ResolvedNativeVMConfig,
    allowLocationFallback: boolean,
    context?: ProviderRequestContext
  ): Promise<VMInstance> {
    throwIfProviderRequestAborted(context);
    const primaryLocation = config.location;

    const fallbackLocations = allowLocationFallback
      ? HETZNER_LOCATIONS.filter((loc) => loc !== primaryLocation)
      : [];
    const attemptsToTry: Array<{ location: string; delayMs: number }> = [
      { location: primaryLocation, delayMs: 0 },
      { location: primaryLocation, delayMs: this.placementRetryDelayMs },
      ...fallbackLocations.map((loc) => ({ location: loc, delayMs: 0 })),
    ];

    let lastError: ProviderError | undefined;
    for (const attempt of attemptsToTry) {
      throwIfProviderRequestAborted(context);
      if (lastError && attempt.delayMs > 0) {
        this.logger.warn('hetzner retrying primary placement after delay', {
          location: attempt.location,
          delayMs: attempt.delayMs,
        });
        await providerDelay(attempt.delayMs, context);
      }

      try {
        const response = await providerFetch(
          this.name,
          `${HETZNER_API_URL}/servers`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.apiToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: config.name,
              server_type: config.instanceType,
              image: config.image || DEFAULT_HETZNER_IMAGE,
              location: attempt.location,
              user_data: config.userData,
              labels: config.labels,
              start_after_create: true,
            }),
          },
          undefined,
          undefined,
          context
        );

        throwIfProviderRequestAborted(context);
        const data = validateHetznerServerResponse(
          await parseProviderJson(response, this.name, 'createVM'),
          'createVM'
        );
        throwIfProviderRequestAborted(context);
        if (attempt.location !== primaryLocation) {
          this.logger.info('hetzner placement fallback succeeded', {
            primaryLocation,
            selectedLocation: attempt.location,
          });
        }
        return mapHetznerServerToVMInstance(data.server);
      } catch (err) {
        rethrowIfProviderRequestAborted(err, context);
        // Deliberately broader than `isHetznerPlacementCapacityError` — see its docstring for
        // why the three 412 checks in this codebase differ in precision.
        if (err instanceof ProviderError && err.statusCode === 412) {
          this.logger.warn('hetzner placement attempt failed', {
            location: attempt.location,
            statusCode: err.statusCode,
          });
          lastError = err;
          continue;
        }
        throw err; // Non-placement errors bubble up (including transient 422s)
      }
    }

    if (lastError) throw lastError;
    throw new ProviderError(this.name, undefined, 'No Hetzner placement attempts were available');
  }
}
