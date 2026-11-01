/**
 * Composable Credentials — generalized resolver.
 *
 * Collapses the two parallel resolution functions into ONE pure resolver
 * parameterized by a ConsumerRef, most specific tier first:
 *
 *   profile attachment → project attachment → user attachment → platform default
 *
 * Preserves Rule 28: an INACTIVE profile- or project-scoped attachment (or one
 * whose configuration or credential is inactive) does NOT fall through — it
 * stops the chain. A user-scoped attachment that cannot be used falls through
 * to the platform, as before.
 *
 * `explainResolution` returns the decision plus how every tier was evaluated;
 * `resolveEnvironment` is its result. Both runtime callers and the settings UI
 * read the same function, so the diagnostics cannot disagree with the runtime.
 */

import type {
  Attachment,
  CompositionSnapshot,
  Configuration,
  ConsumerRef,
  Credential,
  ResolutionContext,
  ResolutionSource,
  ResolutionStep,
  ResolutionStepReason,
  ResolutionTier,
  ResolutionTrace,
  ResolvedEnvironment,
} from './types';
import { consumerKey } from './types';

function sameConsumer(a: ConsumerRef, b: ConsumerRef): boolean {
  return consumerKey(a) === consumerKey(b);
}

function findConfiguration(
  snapshot: CompositionSnapshot,
  configurationId: string
): Configuration | undefined {
  return snapshot.configurations.find((c) => c.id === configurationId);
}

function findCredential(
  snapshot: CompositionSnapshot,
  credentialId: string | null
): Credential | null {
  if (credentialId === null) return null;
  return snapshot.credentials.find((c) => c.id === credentialId) ?? null;
}

/**
 * Resolve the environment for a consumer in a given (user, project?, profile?)
 * context.
 *
 * Returns `null` when the chain is explicitly halted (an unusable profile or
 * project attachment) OR when nothing matches and there is no platform default.
 */
export function resolveEnvironment(
  snapshot: CompositionSnapshot,
  consumer: ConsumerRef,
  ctx: ResolutionContext
): ResolvedEnvironment | null {
  return explainResolution(snapshot, consumer, ctx).resolved;
}

type TierOutcome =
  | { kind: 'used'; resolved: ResolvedEnvironment; step: ResolutionStep }
  | { kind: 'halted'; step: ResolutionStep }
  | { kind: 'continue'; step: ResolutionStep };

/** Resolve and record every tier, most specific first. */
export function explainResolution(
  snapshot: CompositionSnapshot,
  consumer: ConsumerRef,
  ctx: ResolutionContext
): ResolutionTrace {
  const forConsumer = snapshot.attachments.filter((a) => sameConsumer(a.consumer, consumer));
  const tiers: Array<{ tier: ResolutionTier; evaluate: () => TierOutcome }> = [];
  if (ctx.profileId !== undefined && consumer.kind === 'agent') {
    const profileId = ctx.profileId;
    tiers.push({
      tier: 'profile',
      evaluate: () => profileTier(snapshot, consumer, ctx, profileId),
    });
  }
  if (ctx.projectId !== undefined) {
    const projectId = ctx.projectId;
    tiers.push({
      tier: 'project',
      evaluate: () => projectTier(snapshot, forConsumer, consumer, ctx.userId, projectId),
    });
  }
  tiers.push({
    tier: 'user',
    evaluate: () => userTier(snapshot, forConsumer, consumer, ctx.userId),
  });
  tiers.push({ tier: 'platform', evaluate: () => platformTier(snapshot, consumer) });

  const steps: ResolutionStep[] = [];
  let resolved: ResolvedEnvironment | null = null;
  let halted = false;
  let decided = false;
  for (const { tier, evaluate } of tiers) {
    if (decided) {
      steps.push(step(tier, 'not-reached', null));
      continue;
    }
    const outcome = evaluate();
    steps.push(outcome.step);
    if (outcome.kind === 'used') {
      resolved = outcome.resolved;
      decided = true;
    } else if (outcome.kind === 'halted') {
      halted = true;
      decided = true;
    }
  }
  return { resolved, halted, steps };
}

function step(
  tier: ResolutionTier,
  state: ResolutionStep['state'],
  attachment: Attachment | null,
  reason: ResolutionStepReason | null = null
): ResolutionStep {
  return {
    tier,
    state,
    attachmentId: attachment?.id ?? null,
    configurationId: attachment?.configurationId ?? null,
    reason,
  };
}

/**
 * A profile pin applies only when it is for the agent type the run actually
 * starts. A skill (or an explicit task agent) can switch the agent, and then
 * the pin is skipped rather than used for an agent it was never chosen for.
 */
function profileTier(
  snapshot: CompositionSnapshot,
  consumer: Extract<ConsumerRef, { kind: 'agent' }>,
  ctx: ResolutionContext,
  profileId: string
): TierOutcome {
  const pins = snapshot.attachments.filter(
    (a) =>
      a.target.scope === 'profile' &&
      a.target.userId === ctx.userId &&
      a.target.profileId === profileId &&
      a.consumer.kind === 'agent'
  );
  const pin = pins.find((a) => sameConsumer(a.consumer, consumer));
  if (!pin || (ctx.profileAgentType !== undefined && consumer.agentType !== ctx.profileAgentType)) {
    const skipped = pin ?? preferredStalePin(pins, ctx.profileAgentType);
    if (!skipped) return { kind: 'continue', step: step('profile', 'not-set', null) };
    return {
      kind: 'continue',
      step: {
        ...step('profile', 'skipped', skipped, 'agent-type-mismatch'),
        pinnedAgentType: skipped.consumer.kind === 'agent' ? skipped.consumer.agentType : undefined,
      },
    };
  }
  return haltingTier('profile', snapshot, pin, consumer, 'profile-attachment');
}

/** The pin worth reporting as skipped: the one for the running agent first. */
function preferredStalePin(
  pins: Attachment[],
  profileAgentType: string | undefined
): Attachment | undefined {
  return (
    pins.find((a) => a.consumer.kind === 'agent' && a.consumer.agentType === profileAgentType) ??
    pins[0]
  );
}

function projectTier(
  snapshot: CompositionSnapshot,
  forConsumer: Attachment[],
  consumer: ConsumerRef,
  userId: string,
  projectId: string
): TierOutcome {
  const pin = forConsumer.find(
    (a) =>
      a.target.scope === 'project' && a.target.userId === userId && a.target.projectId === projectId
  );
  if (!pin) return { kind: 'continue', step: step('project', 'not-set', null) };
  return haltingTier('project', snapshot, pin, consumer, 'project-attachment');
}

/** Rule 28: a set but unusable pin at this tier halts the chain. */
function haltingTier(
  tier: 'profile' | 'project',
  snapshot: CompositionSnapshot,
  pin: Attachment,
  consumer: ConsumerRef,
  source: ResolutionSource
): TierOutcome {
  if (!pin.isActive) return { kind: 'halted', step: step(tier, 'halted', pin, 'paused') };
  const result = materialize(snapshot, pin, consumer, source);
  if ('reason' in result) {
    return { kind: 'halted', step: step(tier, 'halted', pin, result.reason) };
  }
  return { kind: 'used', resolved: result.resolved, step: step(tier, 'used', pin) };
}

function userTier(
  snapshot: CompositionSnapshot,
  forConsumer: Attachment[],
  consumer: ConsumerRef,
  userId: string
): TierOutcome {
  const userAttachments = forConsumer.filter(
    (a) => a.target.scope === 'user' && a.target.userId === userId
  );
  const active = userAttachments.find((a) => a.isActive);
  if (!active) {
    const paused = userAttachments[0];
    return {
      kind: 'continue',
      step: paused ? step('user', 'skipped', paused, 'paused') : step('user', 'not-set', null),
    };
  }
  const result = materialize(snapshot, active, consumer, 'user-attachment');
  if ('reason' in result) {
    return { kind: 'continue', step: step('user', 'skipped', active, result.reason) };
  }
  return { kind: 'used', resolved: result.resolved, step: step('user', 'used', active) };
}

function platformTier(snapshot: CompositionSnapshot, consumer: ConsumerRef): TierOutcome {
  const platform = snapshot.platform[consumerKey(consumer)];
  if (!platform) return { kind: 'continue', step: step('platform', 'not-set', null) };
  const resolved: ResolvedEnvironment =
    platform.mode === 'proxy'
      ? { consumer, configuration: null, credential: null, source: 'platform-proxy' }
      : { consumer, configuration: null, credential: platform.credential, source: 'platform' };
  return { kind: 'used', resolved, step: step('platform', 'used', null) };
}

function materialize(
  snapshot: CompositionSnapshot,
  attachment: Attachment,
  consumer: ConsumerRef,
  source: ResolutionSource
): { resolved: ResolvedEnvironment } | { reason: ResolutionStepReason } {
  const configuration = findConfiguration(snapshot, attachment.configurationId);
  if (!configuration) return { reason: 'configuration-missing' };
  if (!configuration.isActive) return { reason: 'configuration-inactive' };

  const credential = findCredential(snapshot, configuration.credentialId);
  if (configuration.credentialId !== null) {
    if (!credential) return { reason: 'credential-missing' };
    if (!credential.isActive) return { reason: 'credential-inactive' };
  }

  return { resolved: { consumer, configuration, credential, source } };
}
