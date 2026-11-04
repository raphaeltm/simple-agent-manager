/** Production-shaped managed pool VM nodes for Workers tests that drive real teardown. */
import { env } from 'cloudflare:test';

import type { Env } from '../../../src/env';
import { getCredentialEncryptionKey } from '../../../src/lib/secrets';
import { encrypt } from '../../../src/services/encryption';
import { fingerprintEncryptedProviderCredential } from '../../../src/services/provider-credential-exact';
import { seedManagedVmAbsenceProof, seedNode } from './seed-d1';

const HOUR = 60 * 60 * 1000;

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

export interface PoolNodeOptions {
  userId: string;
  createdAt?: string;
  healthStatus?: string;
  nodeClass?: 'managed' | 'user-owned';
  nodeRole?: 'workspace' | 'deployment';
  runtime?: 'vm' | 'cf-container';
  warmSince?: string | null;
  provenance?: boolean;
  cleanupBackoffUntil?: string;
  lastHeartbeatAt?: string | null;
}

/**
 * A running VM shaped like production pool placement: no task link, provenance only in the
 * server-written pool/credential snapshot (the incident node's exact shape).
 */
export async function seedRunningPoolNode(nodeId: string, opts: PoolNodeOptions): Promise<void> {
  const userId = opts.userId;
  const now = new Date().toISOString();
  await seedNode(nodeId, userId, {
    status: 'running',
    createdAt: opts.createdAt ?? ago(3 * HOUR),
    updatedAt: now,
    lastHeartbeatAt: opts.lastHeartbeatAt === undefined ? now : opts.lastHeartbeatAt,
    healthStatus: opts.healthStatus ?? 'healthy',
    warmSince: opts.warmSince ?? null,
    nodeClass: opts.nodeClass ?? 'managed',
  });
  if (opts.provenance !== false) {
    await seedManagedVmAbsenceProof(nodeId, userId);
    // Running: the provider still holds the server, so there is no termination proof yet.
    await env.DATABASE.prepare(
      `UPDATE nodes SET provider_instance_id = ?, runtime_termination_confirmed_at = NULL
        WHERE id = ?`
    )
      .bind(`${nodeId}-server`, nodeId)
      .run();
  }
  if (opts.nodeRole === 'deployment') {
    await env.DATABASE.prepare(
      `UPDATE nodes SET node_role = 'deployment', workload_role = 'deployment' WHERE id = ?`
    )
      .bind(nodeId)
      .run();
  }
  if (opts.runtime) {
    await env.DATABASE.prepare('UPDATE nodes SET runtime = ? WHERE id = ?')
      .bind(opts.runtime, nodeId)
      .run();
  }
  if (opts.cleanupBackoffUntil) {
    await env.DATABASE.prepare('UPDATE nodes SET cleanup_backoff_until = ? WHERE id = ?')
      .bind(opts.cleanupBackoffUntil, nodeId)
      .run();
  }
}

/** Make the node's platform credential decryptable so strict provider teardown can run. */
export async function bindDecryptableProviderCredential(nodeId: string): Promise<void> {
  const credentialId = `${nodeId}-proof-credential`;
  const token = await encrypt(
    'hetzner-test-token',
    getCredentialEncryptionKey(env as unknown as Env)
  );
  await env.DATABASE.prepare(
    'UPDATE platform_credentials SET encrypted_token = ?, iv = ?, is_enabled = 1 WHERE id = ?'
  )
    .bind(token.ciphertext, token.iv, credentialId)
    .run();
  await env.DATABASE.prepare(
    `UPDATE nodes SET placement_credential_reference = ?, placement_credential_fingerprint = ?
      WHERE id = ?`
  )
    .bind(
      `platform_credentials:${credentialId}`,
      await fingerprintEncryptedProviderCredential(token.ciphertext, token.iv),
      nodeId
    )
    .run();
}
