/**
 * Composable Credentials — generalized resolver.
 *
 * Collapses the two parallel resolution functions into ONE pure resolver
 * parameterized by a ConsumerRef:
 *
 *   project attachment → user attachment → platform default
 *
 * Preserves Rule 28: an INACTIVE project-scoped attachment does NOT fall
 * through to the user scope — it stops the chain.
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
      // Rule 28: an inactive project-scoped row HALTS the chain.
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
  if (configuration.credentialId !== null && (!credential || !credential.isActive)) {
    return null;
  }

  return { consumer, configuration, credential, source };
}
