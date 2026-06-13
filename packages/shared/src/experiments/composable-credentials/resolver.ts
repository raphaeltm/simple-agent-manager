/**
 * EXPERIMENT (E2/E1) — the generalized resolver.
 *
 * Today there are TWO parallel resolution functions with the same
 * "most-specific → platform fallback" shape:
 *   - getDecryptedAgentKey()      apps/api/src/routes/credentials.ts:671-755
 *       chain: project-scoped → user-scoped → platform
 *   - createProviderForUser()     apps/api/src/services/provider-credentials.ts:197-265
 *       chain: user cloud cred → platform cloud cred
 *
 * This experiment proves both collapse into ONE pure resolver parameterized by
 * a ConsumerRef. The resolver walks:
 *
 *   project attachment → user attachment → platform default
 *
 * Critically it preserves the Rule 28 security invariant: an INACTIVE
 * project-scoped attachment does NOT fall through to the user scope — it stops
 * the chain (an inactive project row represents an explicit deactivation).
 */

import type {
  Attachment,
  CompositionSnapshot,
  Configuration,
  ConsumerRef,
  Credential,
  ResolutionContext,
  ResolvedEnvironment,
} from './types';
import { consumerKey } from './types';

function sameConsumer(a: ConsumerRef, b: ConsumerRef): boolean {
  return consumerKey(a) === consumerKey(b);
}

function findConfiguration(
  snapshot: CompositionSnapshot,
  configurationId: string,
): Configuration | undefined {
  return snapshot.configurations.find((c) => c.id === configurationId);
}

function findCredential(
  snapshot: CompositionSnapshot,
  credentialId: string | null,
): Credential | null {
  if (credentialId === null) return null;
  return snapshot.credentials.find((c) => c.id === credentialId) ?? null;
}

/**
 * Resolve the environment for a consumer in a given (user, project?) context.
 *
 * Returns `null` when the chain is explicitly halted (inactive project
 * attachment) OR when nothing matches and there is no platform default.
 */
export function resolveEnvironment(
  snapshot: CompositionSnapshot,
  consumer: ConsumerRef,
  ctx: ResolutionContext,
): ResolvedEnvironment | null {
  const forConsumer = snapshot.attachments.filter((a) => sameConsumer(a.consumer, consumer));

  // --- Tier 1: project-scoped attachment -----------------------------------
  if (ctx.projectId !== undefined) {
    const projectAttachment = forConsumer.find(
      (a) =>
        a.target.scope === 'project' &&
        a.target.userId === ctx.userId &&
        a.target.projectId === ctx.projectId,
    );

    if (projectAttachment) {
      // Rule 28: an inactive project-scoped row HALTS the chain. It must not
      // fall through to the user scope.
      if (!projectAttachment.isActive) return null;

      const resolved = materialize(snapshot, projectAttachment, consumer, 'project-attachment');
      if (resolved) return resolved;
      return null;
    }
  }

  // --- Tier 2: user-scoped attachment --------------------------------------
  const userAttachment = forConsumer.find(
    (a) => a.target.scope === 'user' && a.target.userId === ctx.userId && a.isActive,
  );
  if (userAttachment) {
    const resolved = materialize(snapshot, userAttachment, consumer, 'user-attachment');
    if (resolved) return resolved;
  }

  // --- Tier 3: platform default --------------------------------------------
  const platform = snapshot.platform[consumerKey(consumer)];
  if (platform) {
    if (platform.mode === 'proxy') {
      return { consumer, configuration: null, credential: null, source: 'platform-proxy' };
    }
    return { consumer, configuration: null, credential: platform.credential, source: 'platform' };
  }

  return null;
}

function materialize(
  snapshot: CompositionSnapshot,
  attachment: Attachment,
  consumer: ConsumerRef,
  source: 'project-attachment' | 'user-attachment',
): ResolvedEnvironment | null {
  const configuration = findConfiguration(snapshot, attachment.configurationId);
  if (!configuration || !configuration.isActive) return null;

  const credential = findCredential(snapshot, configuration.credentialId);
  // A configuration with a credentialId that points at an inactive/missing
  // credential is treated as unresolved at this tier.
  if (configuration.credentialId !== null && (!credential || !credential.isActive)) {
    return null;
  }

  return { consumer, configuration, credential, source };
}
