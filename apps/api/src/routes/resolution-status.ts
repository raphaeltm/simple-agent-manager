/**
 * GET /api/credentials/resolution-status — read-only view of how each consumer
 * currently resolves for the authenticated user.
 *
 * Used by the Connections overview in Settings to show resolution badges
 * (project override / your default / SAM platform / halted / unresolved).
 *
 * Per Rule 41: tolerates individual bad rows — a single malformed credential
 * does not crash the entire response.
 */

import type {
  CCCompositionSnapshot,
  CCConsumerRef,
  CCConsumerResolutionStatus,
  CCResolutionStatusResponse,
} from '@simple-agent-manager/shared';
import {
  AGENT_CATALOG,
  consumerKey,
  CREDENTIAL_PROVIDERS,
  resolveEnvironment,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { lazyBackfillIfNeeded } from '../services/composable-credentials/lazy-backfill';
import { buildSnapshot } from '../services/composable-credentials/snapshot';

const resolutionStatusRoute = new Hono<{ Bindings: Env }>();

/** Cloud provider display names for the Connections overview. */
const CLOUD_PROVIDER_NAMES: Record<string, string> = {
  hetzner: 'Hetzner Cloud',
  scaleway: 'Scaleway',
  gcp: 'Google Cloud (GCP)',
};

resolutionStatusRoute.get(
  '/resolution-status',
  requireAuth(),
  requireApproved(),
  async (c) => {
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });
    const encryptionKey = getCredentialEncryptionKey(c.env);
    const projectId = c.req.query('projectId') || undefined;

    // Ensure lazy backfill has run for this user
    await lazyBackfillIfNeeded(db, userId);

    // Build a single snapshot and resolve each consumer against it
    const snapshot = await buildSnapshot(db, userId, encryptionKey, projectId);

    const consumers: CCConsumerResolutionStatus[] = [];

    // Resolve agents
    for (const agent of AGENT_CATALOG) {
      try {
        const consumer: CCConsumerRef = { kind: 'agent', agentType: agent.id };
        consumers.push(
          resolveConsumerStatus(snapshot, consumer, agent.id, 'agent', agent.name, userId, projectId),
        );
      } catch (err) {
        // Per Rule 41: skip bad consumer, don't crash the response
        log.error('resolution-status.agent-error', {
          consumerId: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        consumers.push({
          consumerId: agent.id,
          consumerKind: 'agent',
          consumerName: agent.name,
          source: 'unresolved',
          maskedLabel: null,
          halted: false,
        });
      }
    }

    // Resolve cloud providers
    for (const provider of CREDENTIAL_PROVIDERS) {
      try {
        const consumer: CCConsumerRef = { kind: 'compute', provider };
        const name = CLOUD_PROVIDER_NAMES[provider] ?? provider;
        consumers.push(
          resolveConsumerStatus(snapshot, consumer, provider, 'compute', name, userId, projectId),
        );
      } catch (err) {
        log.error('resolution-status.compute-error', {
          consumerId: provider,
          error: err instanceof Error ? err.message : String(err),
        });
        consumers.push({
          consumerId: provider,
          consumerKind: 'compute',
          consumerName: CLOUD_PROVIDER_NAMES[provider] ?? provider,
          source: 'unresolved',
          maskedLabel: null,
          halted: false,
        });
      }
    }

    const response: CCResolutionStatusResponse = { consumers };
    return c.json(response);
  },
);

/**
 * Resolve a single consumer and produce its status entry.
 */
function resolveConsumerStatus(
  snapshot: CCCompositionSnapshot,
  consumer: CCConsumerRef,
  consumerId: string,
  consumerKind: 'agent' | 'compute',
  consumerName: string,
  userId: string,
  projectId?: string,
): CCConsumerResolutionStatus {
  const ctx = { userId, projectId };
  const resolved = resolveEnvironment(snapshot, consumer, ctx);

  if (resolved) {
    return {
      consumerId,
      consumerKind,
      consumerName,
      source: resolved.source,
      maskedLabel: resolved.credential?.name ?? null,
      halted: false,
    };
  }

  // Check for Rule 28 halt (inactive project-scoped attachment)
  if (projectId && isHalted(snapshot, consumer, userId, projectId)) {
    return {
      consumerId,
      consumerKind,
      consumerName,
      source: 'halted',
      maskedLabel: null,
      halted: true,
    };
  }

  return {
    consumerId,
    consumerKind,
    consumerName,
    source: 'unresolved',
    maskedLabel: null,
    halted: false,
  };
}

/**
 * Check if a consumer is halted (inactive project-scoped attachment per Rule 28).
 */
function isHalted(
  snapshot: CCCompositionSnapshot,
  consumer: CCConsumerRef,
  userId: string,
  projectId: string,
): boolean {
  const key = consumerKey(consumer);
  return snapshot.attachments.some(
    (a) =>
      consumerKey(a.consumer) === key &&
      a.target.scope === 'project' &&
      a.target.userId === userId &&
      'projectId' in a.target &&
      a.target.projectId === projectId &&
      !a.isActive,
  );
}

export { resolutionStatusRoute };
