/**
 * Which stored account each agent profile would run on for one person in one project, for the
 * Connector's monitoring reads (`sam_profiles_list`, `sam_usage_get`).
 *
 * The decision is the shared pure resolver `explainResolution`
 * (`packages/shared/src/composable-credentials/resolver.ts`), the same function the agent-key
 * callback runs (`getDecryptedAgentKey` → `resolveAgentKeyViaCC`) and the web profile editor
 * shows (`explainProfileAccount`). The resolver never reads secret values, so this snapshot is
 * built from row metadata only: nothing is decrypted, and no token, ciphertext or IV leaves this
 * module. When the person has no cc_* rows yet, the agent-key path falls back to the legacy
 * `credentials` table (`resolveAgentKeyLegacy`); this does the same, read-only.
 *
 * Quota pools: two stored rows with byte-identical `(encrypted_token, iv)` are copies of one
 * secret (dual-writes copy ciphertext verbatim and every encryption uses a fresh random IV; see
 * `run-agent-credential.ts`). Profiles that resolve to any copy share one pool, so a reader can
 * never treat them as independent quotas. The ciphertext is compared in memory and discarded.
 *
 * Scoping (`.claude/rules/11`, `.claude/rules/28`): every query binds the caller's user id, so
 * another member's credentials, configurations and pins can neither be returned nor change the
 * answer. One malformed row is skipped, never fatal (`.claude/rules/41`, `.claude/rules/50`).
 */
import type { ProfileAccountBinding } from '@simple-agent-manager/operations';
import {
  type CCAttachment,
  type CCCompositionSnapshot,
  type CCConfiguration,
  type CCCredential,
  explainResolution,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';

type CredentialRow = {
  id: unknown;
  name: unknown;
  is_active: unknown;
  encrypted_token: unknown;
  iv: unknown;
};
type ConfigurationRow = {
  id: unknown;
  consumer_target: unknown;
  credential_id: unknown;
  is_active: unknown;
};
type AttachmentRow = {
  id: unknown;
  configuration_id: unknown;
  consumer_target: unknown;
  project_id: unknown;
  is_active: unknown;
};
type ProfilePinRow = {
  id: unknown;
  configuration_id: unknown;
  agent_profile_id: unknown;
  consumer_target: unknown;
  is_active: unknown;
};
type PlatformRow = { id: unknown; agent_type: unknown };
type LegacyRow = {
  id: unknown;
  project_id: unknown;
  agent_type: unknown;
  is_active: unknown;
  encrypted_token: unknown;
  iv: unknown;
};

const OWNER = 'caller';

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function flag(value: unknown): boolean {
  return value === 1 || value === true;
}

/** Identity of one stored secret generation, compared in memory only. */
function generationKey(row: { encrypted_token: unknown; iv: unknown }): string | null {
  const token = text(row.encrypted_token);
  const iv = text(row.iv);
  return token && iv ? `${token}\u0000${iv}` : null;
}

function skipRow(table: string, id: unknown): void {
  log.warn('profile_account_bindings.row_skipped', {
    table,
    rowId: typeof id === 'string' ? id : null,
  });
}

interface StoredSecret {
  reference: string;
  generation: string | null;
}

/**
 * Every stored copy of the same secret, keyed by generation. The pool id is the
 * smallest reference in the group so it is stable across calls.
 */
class PoolIndex {
  private readonly byGeneration = new Map<string, string[]>();

  add(secret: StoredSecret): void {
    if (!secret.generation) return;
    const group = this.byGeneration.get(secret.generation) ?? [];
    group.push(secret.reference);
    this.byGeneration.set(secret.generation, group);
  }

  pool(secret: StoredSecret): { poolId: string; references: string[] } {
    const group = secret.generation ? this.byGeneration.get(secret.generation) : undefined;
    const references = [...new Set(group ?? [secret.reference])].sort();
    return { poolId: references[0] ?? secret.reference, references };
  }
}

interface Loaded {
  credentials: CredentialRow[];
  configurations: ConfigurationRow[];
  attachments: AttachmentRow[];
  pins: ProfilePinRow[];
  platform: PlatformRow[];
  legacy: LegacyRow[];
}

async function load(env: Env, userId: string, projectId: string): Promise<Loaded> {
  const db = env.DATABASE;
  const [credentials, configurations, attachments, pins, platform, legacy] = await db.batch([
    db
      .prepare(
        `SELECT id, name, is_active, encrypted_token, iv FROM cc_credentials WHERE owner_id = ?`
      )
      .bind(userId),
    db
      .prepare(
        `SELECT id, consumer_target, credential_id, is_active FROM cc_configurations
          WHERE owner_id = ? AND consumer_kind = 'agent'`
      )
      .bind(userId),
    db
      .prepare(
        `SELECT id, configuration_id, consumer_target, project_id, is_active FROM cc_attachments
          WHERE user_id = ? AND consumer_kind = 'agent' AND (project_id IS NULL OR project_id = ?)`
      )
      .bind(userId, projectId),
    db
      .prepare(
        `SELECT id, configuration_id, agent_profile_id, consumer_target, is_active
           FROM cc_profile_attachments WHERE user_id = ? AND consumer_kind = 'agent'`
      )
      .bind(userId),
    db.prepare(
      `SELECT id, agent_type FROM platform_credentials
        WHERE is_enabled = 1 AND credential_type = 'agent-api-key' AND agent_type IS NOT NULL`
    ),
    db
      .prepare(
        `SELECT id, project_id, agent_type, is_active, encrypted_token, iv FROM credentials
          WHERE user_id = ? AND credential_type = 'agent-api-key'
            AND (project_id IS NULL OR project_id = ?)
          ORDER BY id`
      )
      .bind(userId, projectId),
  ]);
  return {
    credentials: (credentials?.results ?? []) as CredentialRow[],
    configurations: (configurations?.results ?? []) as ConfigurationRow[],
    attachments: (attachments?.results ?? []) as AttachmentRow[],
    pins: (pins?.results ?? []) as ProfilePinRow[],
    platform: (platform?.results ?? []) as PlatformRow[],
    legacy: (legacy?.results ?? []) as LegacyRow[],
  };
}

/** A resolver snapshot with placeholder secrets: the resolver decides on ids and flags only. */
function toSnapshot(rows: Loaded): CCCompositionSnapshot {
  const credentials: CCCredential[] = [];
  for (const row of rows.credentials) {
    const id = text(row.id);
    if (!id) {
      skipRow('cc_credentials', row.id);
      continue;
    }
    credentials.push({
      id,
      ownerId: OWNER,
      name: text(row.name) ?? id,
      kind: 'api-key',
      secret: { kind: 'api-key', apiKey: '' },
      isActive: flag(row.is_active),
    });
  }
  const configurations: CCConfiguration[] = [];
  for (const row of rows.configurations) {
    const id = text(row.id);
    const agentType = text(row.consumer_target);
    if (!id || !agentType) {
      skipRow('cc_configurations', row.id);
      continue;
    }
    configurations.push({
      id,
      ownerId: OWNER,
      name: id,
      consumer: { kind: 'agent', agentType },
      credentialId: text(row.credential_id),
      settings: {},
      isActive: flag(row.is_active),
    });
  }
  const attachments: CCAttachment[] = [];
  for (const row of rows.attachments) {
    const id = text(row.id);
    const configurationId = text(row.configuration_id);
    const agentType = text(row.consumer_target);
    if (!id || !configurationId || !agentType) {
      skipRow('cc_attachments', row.id);
      continue;
    }
    const attachedProject = text(row.project_id);
    attachments.push({
      id,
      configurationId,
      consumer: { kind: 'agent', agentType },
      target: attachedProject
        ? { scope: 'project', userId: OWNER, projectId: attachedProject }
        : { scope: 'user', userId: OWNER },
      isActive: flag(row.is_active),
    });
  }
  for (const row of rows.pins) {
    const id = text(row.id);
    const configurationId = text(row.configuration_id);
    const profileId = text(row.agent_profile_id);
    const agentType = text(row.consumer_target);
    if (!id || !configurationId || !profileId || !agentType) {
      skipRow('cc_profile_attachments', row.id);
      continue;
    }
    attachments.push({
      id,
      configurationId,
      consumer: { kind: 'agent', agentType },
      target: { scope: 'profile', userId: OWNER, profileId },
      isActive: flag(row.is_active),
    });
  }
  const platform: CCCompositionSnapshot['platform'] = {};
  for (const row of rows.platform) {
    const id = text(row.id);
    const agentType = text(row.agent_type);
    if (!id || !agentType) continue;
    platform[`agent:${agentType}`] = {
      mode: 'credential',
      credential: {
        id,
        ownerId: '__platform__',
        name: 'platform',
        kind: 'api-key',
        secret: { kind: 'api-key', apiKey: '' },
        isActive: true,
      },
    };
  }
  return { credentials, configurations, attachments, platform };
}

function platformBinding(
  profile: { id: string; agentType: string },
  hasPlatform: boolean
): ProfileAccountBinding {
  return hasPlatform
    ? {
        profileId: profile.id,
        agentType: profile.agentType,
        state: 'platform',
        tier: 'platform',
        reason: null,
        poolId: `platform:${profile.agentType}`,
        account: null,
        usageReferences: [],
      }
    : noneBinding(profile);
}

function noneBinding(profile: { id: string; agentType: string }): ProfileAccountBinding {
  return {
    profileId: profile.id,
    agentType: profile.agentType,
    state: 'none',
    tier: null,
    reason: null,
    poolId: null,
    account: null,
    usageReferences: [],
  };
}

/** Read-only mirror of `resolveAgentKeyLegacy` for a person with no cc_* rows. */
function legacyBinding(
  rows: Loaded,
  pools: PoolIndex,
  profile: { id: string; agentType: string },
  projectId: string,
  hasPlatform: boolean
): ProfileAccountBinding {
  const forAgent = rows.legacy.filter((row) => text(row.agent_type) === profile.agentType);
  const projectRow = forAgent.find((row) => text(row.project_id) === projectId);
  const chosen = projectRow ?? forAgent.find((row) => !text(row.project_id) && flag(row.is_active));
  const tier = projectRow ? 'project' : 'user';
  if (projectRow && !flag(projectRow.is_active)) {
    return {
      ...noneBinding(profile),
      state: 'paused',
      tier: 'project',
      reason: 'credential-inactive',
    };
  }
  const id = chosen ? text(chosen.id) : null;
  if (!chosen || !id) return platformBinding(profile, hasPlatform);
  const pool = pools.pool({ reference: `credentials:${id}`, generation: generationKey(chosen) });
  return {
    profileId: profile.id,
    agentType: profile.agentType,
    state: 'account',
    tier,
    reason: null,
    poolId: pool.poolId,
    account: { name: null, storage: 'legacy' },
    usageReferences: pool.references,
  };
}

/**
 * The account each profile resolves to for `userId` running in `projectId`. Never decrypts and
 * never returns secret material; `usageReferences` are opaque `cc_credentials:<id>` /
 * `credentials:<id>` references of the caller's own rows, used to match usage samples.
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
  const rows = await load(env, input.userId, input.projectId);
  const pools = new PoolIndex();
  const namesById = new Map<string, string | null>();
  for (const row of rows.credentials) {
    const id = text(row.id);
    if (!id) continue;
    namesById.set(id, text(row.name));
    pools.add({ reference: `cc_credentials:${id}`, generation: generationKey(row) });
  }
  for (const row of rows.legacy) {
    const id = text(row.id);
    if (id) pools.add({ reference: `credentials:${id}`, generation: generationKey(row) });
  }
  const generationById = new Map(
    rows.credentials.flatMap((row) => {
      const id = text(row.id);
      return id ? [[id, generationKey(row)] as const] : [];
    })
  );
  const platformAgents = new Set(rows.platform.map((row) => text(row.agent_type)));
  // Same switch as the agent-key path: cc rows exist → cc decides; none → legacy table.
  const useCC = rows.credentials.length > 0;
  const snapshot = useCC ? toSnapshot(rows) : null;

  return input.profiles.map((profile) => {
    const hasPlatform = platformAgents.has(profile.agentType);
    if (!snapshot) return legacyBinding(rows, pools, profile, input.projectId, hasPlatform);
    const trace = explainResolution(
      snapshot,
      { kind: 'agent', agentType: profile.agentType },
      {
        userId: OWNER,
        projectId: input.projectId,
        profileId: profile.id,
        profileAgentType: profile.agentType,
      }
    );
    if (trace.halted) {
      const step = trace.steps.find((candidate) => candidate.state === 'halted');
      const configuration = snapshot.configurations.find(
        (candidate) => candidate.id === step?.configurationId
      );
      const credentialId = configuration?.credentialId ?? null;
      return {
        ...noneBinding(profile),
        state: 'paused',
        tier: step?.tier ?? null,
        reason: step?.reason ?? null,
        account: credentialId
          ? { name: namesById.get(credentialId) ?? null, storage: 'account' }
          : null,
      };
    }
    const resolved = trace.resolved;
    if (!resolved) return noneBinding(profile);
    if (resolved.source === 'platform' || resolved.source === 'platform-proxy') {
      return platformBinding(profile, true);
    }
    const credentialId = resolved.credential?.id ?? null;
    if (!credentialId) return noneBinding(profile);
    const pool = pools.pool({
      reference: `cc_credentials:${credentialId}`,
      generation: generationById.get(credentialId) ?? null,
    });
    return {
      profileId: profile.id,
      agentType: profile.agentType,
      state: 'account',
      tier:
        resolved.source === 'profile-attachment'
          ? 'profile'
          : resolved.source === 'project-attachment'
            ? 'project'
            : 'user',
      reason: null,
      poolId: pool.poolId,
      account: { name: namesById.get(credentialId) ?? null, storage: 'account' },
      usageReferences: pool.references,
    };
  });
}
