/**
 * POST /:id/agent-credential-sync — VM agent callback to sync refreshed credentials.
 * Called after a session ends when the agent used file-based credential injection
 * (e.g. codex-acp auth.json) and the credential may have been refreshed during the session.
 * The VM agent reads the updated auth file from the container and sends it here.
 * Uses workspace callback auth.
 *
 * The write target is the credential the workspace's run was seeded with
 * (`resolveRunAgentCredentialReferences`), not "the user's default": a run on a
 * project- or profile-pinned account must never overwrite the default account.
 */
import { isValidAgentType } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/route-helpers';
import { getCredentialEncryptionKey } from '../../lib/secrets';
import { errors } from '../../middleware/error';
import { AgentCredentialSyncSchema, jsonValidator } from '../../schemas';
import { decrypt, encrypt } from '../../services/encryption';
import {
  loadRunAgentCredential,
  parseCodexAuth,
  resolveRunAgentCredentialReferences,
  type RunAgentCredential,
  writeRotatedAgentCredential,
} from '../../services/run-agent-credential';
import {
  assertWorkspaceCallbackIdentityCurrent,
  assertWorkspaceCallbackResourceById,
  verifyWorkspaceCallbackAuth,
} from './_helpers';

const agentCredentialSyncRoutes = new Hono<{ Bindings: Env }>();

const VALID_CREDENTIAL_KINDS = new Set(['api-key', 'oauth-token']);
const DEFAULT_MAX_AGENT_CREDENTIAL_SYNC_BYTES = 64 * 1024;

interface SyncCandidate {
  credential: RunAgentCredential;
  plaintext: string;
}

type SyncSelection =
  | { ok: true; candidate: SyncCandidate }
  | { ok: false; reason: 'credential_account_mismatch' | 'credential_ambiguous' };

/**
 * Pick which seeded credential the synced file belongs to. For Codex, the
 * auth.json `tokens.account_id` identifies the account: a stored credential of a
 * different account is never a target. With one candidate, a missing account id
 * on either side is accepted (nothing else it could belong to). With several, the
 * synced file must name its account and a candidate must match it exactly: a
 * missing id is ambiguous, never a wildcard. Several stored copies of the same
 * account resolve to the most recently used one (candidates arrive in that order).
 */
export function selectSyncTarget(
  agentType: string,
  syncedCredential: string,
  candidates: SyncCandidate[]
): SyncSelection {
  const [first] = candidates;
  if (!first) return { ok: false, reason: 'credential_ambiguous' };
  const isCodex = agentType === 'openai-codex';
  const accountOf = (credential: string) =>
    isCodex ? parseCodexAuth(credential)?.identity.accountId : undefined;
  const syncedAccount = accountOf(syncedCredential);

  if (candidates.length === 1) {
    const storedAccount = accountOf(first.plaintext);
    return syncedAccount && storedAccount && storedAccount !== syncedAccount
      ? { ok: false, reason: 'credential_account_mismatch' }
      : { ok: true, candidate: first };
  }

  if (!syncedAccount) return { ok: false, reason: 'credential_ambiguous' };
  const accounts = candidates.map((candidate) => ({
    candidate,
    accountId: accountOf(candidate.plaintext),
  }));
  const sameAccount = accounts.find(({ accountId }) => accountId === syncedAccount);
  if (sameAccount) return { ok: true, candidate: sameAccount.candidate };
  return accounts.every(({ accountId }) => accountId)
    ? { ok: false, reason: 'credential_account_mismatch' }
    : { ok: false, reason: 'credential_ambiguous' };
}

agentCredentialSyncRoutes.post(
  '/:id/agent-credential-sync',
  jsonValidator(AgentCredentialSyncSchema),
  async (c) => {
    const workspaceId = c.req.param('id');
    await verifyWorkspaceCallbackAuth(c, workspaceId);

    // Payload size check (64KB default — auth.json files are typically a few KB).
    const contentLength = parseInt(c.req.header('content-length') || '0', 10);
    const maxPayloadBytes = parsePositiveInt(
      c.env.MAX_AGENT_CREDENTIAL_SYNC_BYTES as string,
      DEFAULT_MAX_AGENT_CREDENTIAL_SYNC_BYTES
    );
    if (contentLength > maxPayloadBytes) {
      throw errors.badRequest(`Payload exceeds ${maxPayloadBytes} byte limit`);
    }

    const body = c.req.valid('json');
    const agentType = body.agentType;
    const credentialKind = body.credentialKind;

    // Validate against known values. Use the shared catalog so new agents
    // are accepted automatically without a manual allowlist update.
    if (!agentType || !isValidAgentType(agentType)) {
      throw errors.badRequest('Invalid agentType');
    }
    if (!credentialKind || !VALID_CREDENTIAL_KINDS.has(credentialKind)) {
      throw errors.badRequest('Invalid credentialKind');
    }

    const db = drizzle(c.env.DATABASE, { schema });
    const encryptionKey = getCredentialEncryptionKey(c.env);
    const workspace = await assertWorkspaceCallbackResourceById(
      c.env,
      workspaceId,
      'agent_credential_sync'
    );
    const respond = async (payload: Record<string, unknown>) => {
      await assertWorkspaceCallbackIdentityCurrent(c.env, workspace, 'agent_credential_sync');
      return c.json(payload);
    };

    const references = await resolveRunAgentCredentialReferences(
      db,
      c.env.DATABASE,
      encryptionKey,
      {
        workspaceId,
        userId: workspace.userId,
        projectId: workspace.projectId,
        agentType,
      }
    );

    // An inactive or deleted seeded credential is not replaced by another one
    // (rule 28): nothing is written and the next run re-resolves.
    const candidates: SyncCandidate[] = [];
    for (const reference of references) {
      const credential = await loadRunAgentCredential(c.env.DATABASE, {
        userId: workspace.userId,
        reference,
        agentType,
        credentialKind,
      });
      if (!credential?.isActive) continue;
      try {
        const plaintext = await decrypt(credential.encryptedToken, credential.iv, encryptionKey);
        candidates.push({ credential, plaintext });
      } catch {
        log.error('agent_credential_sync.credential_decrypt_failed', {
          workspaceId,
          agentType,
          credentialReference: reference,
        });
      }
    }
    if (candidates.length === 0) {
      return respond({ success: false, reason: 'credential_not_found' });
    }

    // Only update if the credential has actually changed.
    if (candidates.some((candidate) => candidate.plaintext === body.credential)) {
      return respond({ success: true, updated: false });
    }

    const selection = selectSyncTarget(agentType, body.credential, candidates);
    if (!selection.ok) {
      log.warn('agent_credential_sync.target_rejected', {
        workspaceId,
        agentType,
        reason: selection.reason,
        candidateCount: candidates.length,
      });
      return respond({ success: false, reason: selection.reason });
    }
    const target = selection.candidate.credential;

    // Re-encrypt with a fresh IV; compare-and-set on the ciphertext read above,
    // bound to the workspace callback identity in the same statement.
    const { ciphertext, iv } = await encrypt(body.credential, encryptionKey);
    const write = await writeRotatedAgentCredential(c.env.DATABASE, {
      userId: workspace.userId,
      agentType,
      credentialKind,
      target,
      next: { encryptedToken: ciphertext, iv },
      guard: {
        sql: `EXISTS (
          SELECT 1
            FROM workspaces w
            JOIN nodes n ON n.id = w.node_id
           WHERE w.id = ?
             AND w.user_id = ?
             AND w.project_id IS ?
             AND w.chat_session_id IS ?
             AND w.node_id IS ?
             AND w.status = ?
             AND n.status = ?
        )`,
        binds: [
          workspace.workspaceId,
          workspace.userId,
          workspace.projectId,
          workspace.chatSessionId,
          workspace.nodeId,
          workspace.status,
          workspace.nodeStatus,
        ],
      },
    });
    if (!write.applied) {
      // `respond` throws 410 when the workspace callback identity moved; otherwise
      // the credential itself changed under us and is left alone.
      log.warn('agent_credential_sync.cas_lost', {
        workspaceId,
        agentType,
        credentialReference: target.reference,
      });
      return respond({ success: false, reason: 'credential_changed' });
    }

    log.info('agent_credential_sync.credential_updated', {
      workspaceId,
      agentType,
      credentialKind,
      credentialReference: target.reference,
      mirroredRows: write.mirroredRows,
    });
    return respond({ success: true, updated: true });
  }
);

export { agentCredentialSyncRoutes };
