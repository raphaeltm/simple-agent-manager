/**
 * Which stored account each agent profile would run on for one person in one project, for the
 * Connector's monitoring reads (`sam_profiles_list`, `sam_usage_get`).
 *
 * Selection is not re-implemented here: it is `resolveAgentCredentialSelections`
 * (`agent-credential-selection.ts`), the same precedence the agent-key callback and
 * provider-limit admission use, run over a metadata-only snapshot. This module adds two things
 * the selection does not answer:
 *
 * 1. What a run does without a credential of the person's own. The agent-key route
 *    (`routes/workspaces/runtime.ts`, `POST /:id/agent-key`) never hands a platform credential to
 *    a workspace; it falls back to SAM's AI proxy only as `samProxyFallbackAvailable` says (the
 *    same predicate the route uses), and every other case fails with "Agent credential not found".
 * 2. Quota pools. Stored rows with byte-identical `(encrypted_token, iv)` are copies of one secret
 *    (dual-writes and the cc backfill copy ciphertext verbatim; see `run-agent-credential.ts`), so
 *    profiles on any copy share one provider quota. The equality is computed in SQL, so no
 *    ciphertext reaches this Worker. The pool id is a one-way digest of the member references:
 *    backfilled credential ids embed ciphertext (`credential-limit-events/values.ts`) and must
 *    never leave the platform.
 *
 * Every query binds the caller's user id (rules 11, 28): another member's credentials, pins and
 * settings can neither be returned nor change the answer.
 */
import type { ProfileAccountBinding } from '@simple-agent-manager/operations';
import { drizzle } from 'drizzle-orm/d1';

import type { Env } from '../env';
import { maybeJsonRecord } from '../lib/runtime-validation';
import { resolveAgentCredentialSelections } from './agent-credential-selection';
import { samProxyFallbackAvailable } from './sam-ai-proxy-fallback';

/** The SAM AI proxy budget is per person across agents, so it is one pool. */
export const SAM_AI_PROXY_POOL_ID = 'sam-ai-proxy';

/** Union-find over credential references that name copies of one secret. */
class Pools {
  private readonly parent = new Map<string, string>();

  private find(reference: string): string {
    let root = reference;
    for (let next = this.parent.get(root); next && next !== root; next = this.parent.get(root)) {
      root = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    if (!this.parent.has(a)) this.parent.set(a, a);
    if (!this.parent.has(b)) this.parent.set(b, b);
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    // The smaller reference stays the root, so the grouping is deterministic.
    if (rootA < rootB) this.parent.set(rootB, rootA);
    else this.parent.set(rootA, rootB);
  }

  members(reference: string): string[] {
    if (!this.parent.has(reference)) return [reference];
    const root = this.find(reference);
    return [...this.parent.keys()].filter((candidate) => this.find(candidate) === root).sort();
  }
}

async function poolDigest(references: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode([...references].sort().join('\n'));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `pool_${Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Each result row as a record; a non-object row is skipped (rule 50). */
function rows(result: D1Result | undefined): Record<string, unknown>[] {
  return (result?.results ?? []).flatMap((row) => {
    const record = maybeJsonRecord(row);
    return record ? [record] : [];
  });
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

async function loadPoolsAndModes(env: Env, userId: string) {
  const db = env.DATABASE;
  const [ccEdges, legacyEdges, modes] = await db.batch([
    // Distinct cc rows of mine holding the same ciphertext.
    db
      .prepare(
        `SELECT a.id AS a, b.id AS b FROM cc_credentials a
           JOIN cc_credentials b
             ON b.owner_id = a.owner_id AND b.id > a.id
            AND b.encrypted_token = a.encrypted_token AND b.iv = a.iv
          WHERE a.owner_id = ?`
      )
      .bind(userId),
    // Legacy agent keys of mine mirrored into cc rows of mine.
    db
      .prepare(
        `SELECT l.id AS a, c.id AS b FROM credentials l
           JOIN cc_credentials c
             ON c.owner_id = l.user_id
            AND c.encrypted_token = l.encrypted_token AND c.iv = l.iv
          WHERE l.user_id = ? AND l.credential_type = 'agent-api-key'`
      )
      .bind(userId),
    db
      .prepare(`SELECT agent_type, provider_mode FROM agent_settings WHERE user_id = ?`)
      .bind(userId),
  ]);
  const pools = new Pools();
  for (const row of rows(ccEdges)) {
    const a = text(row.a);
    const b = text(row.b);
    if (a && b) pools.union(`cc_credentials:${a}`, `cc_credentials:${b}`);
  }
  for (const row of rows(legacyEdges)) {
    const a = text(row.a);
    const b = text(row.b);
    if (a && b) pools.union(`credentials:${a}`, `cc_credentials:${b}`);
  }
  const providerModes = new Map<string, string | null>();
  for (const row of rows(modes)) {
    const agentType = text(row.agent_type);
    if (agentType) providerModes.set(agentType, text(row.provider_mode));
  }
  return { pools, providerModes };
}

/**
 * The account each profile resolves to for `userId` running in `projectId`. Never decrypts and
 * never returns secret material; `usageReferences` are the caller's own credential references,
 * internal to the usage read.
 */
export async function resolveProfileAccountBindings(
  env: Env,
  input: {
    projectId: string;
    userId: string;
    profiles: readonly { id: string; agentType: string }[];
  }
): Promise<ProfileAccountBinding[]> {
  if (input.profiles.length === 0) return [];
  const [selections, { pools, providerModes }] = await Promise.all([
    resolveAgentCredentialSelections(drizzle(env.DATABASE), input),
    loadPoolsAndModes(env, input.userId),
  ]);
  return Promise.all(
    selections.map(
      async ({
        profileId,
        agentType,
        selection,
        credentialName,
      }): Promise<ProfileAccountBinding> => {
        const base = {
          profileId,
          agentType,
          tier: null,
          reason: null,
          poolId: null,
          account: null,
          usageReferences: [],
        };
        switch (selection.kind) {
          case 'credential': {
            const references = pools.members(selection.reference);
            return {
              ...base,
              state: 'account',
              tier: selection.tier,
              poolId: await poolDigest(references),
              account: {
                name: credentialName,
                storage: selection.reference.startsWith('credentials:') ? 'legacy' : 'account',
              },
              usageReferences: references,
            };
          }
          case 'halted':
            return {
              ...base,
              state: 'paused',
              tier: selection.tier === 'platform' ? null : selection.tier,
              reason: selection.reason,
              account: credentialName ? { name: credentialName, storage: 'account' } : null,
            };
          case 'unknown':
            return { ...base, state: 'unknown' };
          case 'none':
            return samProxyFallbackAvailable(env, agentType, providerModes.get(agentType) ?? null)
              ? { ...base, state: 'sam_ai_proxy', poolId: SAM_AI_PROXY_POOL_ID }
              : { ...base, state: 'none' };
        }
      }
    )
  );
}
