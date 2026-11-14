/**
 * Which stored credential a new agent run would be seeded with, without seeding one: the
 * selection-only half of the agent-key path (`getDecryptedAgentKey` → `resolveAgentKeyViaCC`,
 * legacy fallback `resolveAgentKeyLegacy`), shared by every reader that needs the answer but
 * not the secret.
 *
 * - `getSelectedAgentCredentialReference`: one run's reference, for provider-limit admission and
 *   the credential write-back paths (`run-agent-credential.ts`).
 * - `resolveAgentCredentialSelections`: many profiles at once from one metadata-only snapshot,
 *   for the Connector's account reads (`profile-account-bindings.ts`).
 *
 * Both go through `selectionFromTrace` and `pickLegacyAgentCredential`, so they cannot disagree
 * about precedence. Neither performs lazy backfill or any write.
 */
import {
  type CCResolutionStepReason,
  type CCResolutionTier,
  type CCResolutionTrace,
  explainResolution,
} from '@simple-agent-manager/shared';
import type { drizzle } from 'drizzle-orm/d1';

import { log } from '../lib/logger';
import { mapResolvedToLegacy } from './agent-key-resolution';
import { hasUserCCData } from './composable-credentials/lazy-backfill';
import type { ProfileCredentialContext } from './composable-credentials/profile-context';
import { explainForConsumer } from './composable-credentials/resolve';
import { buildSnapshot } from './composable-credentials/snapshot';
import {
  type LegacyAgentCredentialRow,
  loadLegacyAgentCredentialRows,
  pickLegacyAgentCredential,
} from './legacy-agent-credentials';

type Db = ReturnType<typeof drizzle>;

/** What a run of one agent would be seeded with. */
export type AgentCredentialSelection =
  /** One of the user's own stored credentials. `credentialId` is set for cc rows. */
  | {
      kind: 'credential';
      reference: string;
      /** `run`: the account chosen for this run (`tasks.agent_configuration_id`). */
      tier: 'run' | 'profile' | 'project' | 'user';
      credentialId: string | null;
    }
  /** A pin (profile or project) is unusable, so the run refuses rather than falls back. */
  | {
      kind: 'halted';
      tier: CCResolutionTier;
      reason: CCResolutionStepReason | null;
      configurationId: string | null;
    }
  /**
   * No credential of the user's own. The agent-key route never hands a platform credential to a
   * workspace, so a run then needs SAM's AI proxy (an explicit `sam` provider mode) or fails.
   */
  | { kind: 'none' };

const TIER_BY_SOURCE: Record<
  'run-override' | 'profile-attachment' | 'project-attachment' | 'user-attachment',
  'run' | 'profile' | 'project' | 'user'
> = {
  'run-override': 'run',
  'profile-attachment': 'profile',
  'project-attachment': 'project',
  'user-attachment': 'user',
};

type TraceSelection = AgentCredentialSelection | { kind: 'legacy' } | { kind: 'platform' };

/**
 * The selection a resolution trace implies, before the legacy table is consulted:
 * `legacy` when cc resolved nothing (agent-key falls through to the legacy table), `platform`
 * when cc resolved only a platform default (legacy decides only if the user has no cc rows).
 */
export function selectionFromTrace(trace: CCResolutionTrace): TraceSelection {
  if (trace.halted) {
    const step = trace.steps.find((candidate) => candidate.state === 'halted');
    return {
      kind: 'halted',
      tier: step?.tier ?? 'profile',
      reason: step?.reason ?? null,
      configurationId: step?.configurationId ?? null,
    };
  }
  const resolved = trace.resolved;
  if (!resolved) return { kind: 'legacy' };
  if (resolved.source === 'platform' || resolved.source === 'platform-proxy') {
    return { kind: 'platform' };
  }
  // A credential kind this agent cannot use (e.g. cloud-provider) seeds nothing.
  const mapped = mapResolvedToLegacy(resolved);
  if (!mapped) return { kind: 'none' };
  return {
    kind: 'credential',
    reference: mapped.credentialReference,
    tier: TIER_BY_SOURCE[resolved.source],
    credentialId: resolved.credential?.id ?? null,
  };
}

function fromLegacy(
  rows: readonly LegacyAgentCredentialRow[],
  agentType: string,
  projectId: string | null
): AgentCredentialSelection {
  const pick = pickLegacyAgentCredential(rows, agentType, projectId);
  if (!pick) return { kind: 'none' };
  if (pick.kind === 'halted') {
    return {
      kind: 'halted',
      tier: 'project',
      reason: 'credential-inactive',
      configurationId: null,
    };
  }
  return {
    kind: 'credential',
    reference: `credentials:${pick.row.id}`,
    tier: pick.tier,
    credentialId: null,
  };
}

/** Admission reads current selection without lazy backfill or credential writes. */
export async function getSelectedAgentCredentialReference(
  db: Db,
  userId: string,
  agentType: string,
  encryptionKey: string,
  projectId: string | null,
  profile?: ProfileCredentialContext | null
): Promise<string | null> {
  const trace = await explainForConsumer(
    db,
    userId,
    encryptionKey,
    { kind: 'agent', agentType },
    projectId,
    profile
  );
  const selection = selectionFromTrace(trace);
  // Match lazy-backfill precedence without performing credential writes. Once
  // CC data exists, a platform-only result is authoritative, just as injection.
  const consultLegacy =
    selection.kind === 'legacy' ||
    (selection.kind === 'platform' && !(await hasUserCCData(db, userId)));
  const final = consultLegacy
    ? fromLegacy(
        await loadLegacyAgentCredentialRows(db, userId, projectId, agentType),
        agentType,
        projectId
      )
    : selection;
  return final.kind === 'credential' ? final.reference : null;
}

export interface ProfileCredentialSelection {
  profileId: string;
  agentType: string;
  /** `unknown` when this one profile could not be resolved (logged); others are unaffected. */
  selection: AgentCredentialSelection | { kind: 'unknown' };
  /** The Settings name of the selected (or halted) cc credential, else null. */
  credentialName: string | null;
}

/**
 * The selection for each profile a person could run in `projectId`, from one metadata-only
 * snapshot (no decryption). Profiles are resolved with their own agent type; a skill that
 * switches the agent at start time is not applied here.
 */
export async function resolveAgentCredentialSelections(
  db: Db,
  input: {
    userId: string;
    projectId: string;
    profiles: readonly { id: string; agentType: string }[];
  }
): Promise<ProfileCredentialSelection[]> {
  if (input.profiles.length === 0) return [];
  const snapshot = await buildSnapshot(
    db,
    input.userId,
    // `secrets: 'omit'` never decrypts, so no key is needed.
    '',
    input.projectId,
    null,
    { secrets: 'omit', profileIds: input.profiles.map((profile) => profile.id) }
  );
  // In omit mode no credential row is skipped, so this is exactly `hasUserCCData`.
  const hasCCData = snapshot.credentials.length > 0;
  const names = new Map(snapshot.credentials.map((credential) => [credential.id, credential.name]));
  const configurationCredential = new Map(
    snapshot.configurations.map((configuration) => [configuration.id, configuration.credentialId])
  );
  let legacyRows: Promise<LegacyAgentCredentialRow[]> | null = null;
  const legacy = () =>
    (legacyRows ??= loadLegacyAgentCredentialRows(db, input.userId, input.projectId));

  return Promise.all(
    input.profiles.map(async (profile): Promise<ProfileCredentialSelection> => {
      try {
        const trace = explainResolution(
          snapshot,
          { kind: 'agent', agentType: profile.agentType },
          {
            userId: input.userId,
            projectId: input.projectId,
            profileId: profile.id,
            profileAgentType: profile.agentType,
          }
        );
        const traced = selectionFromTrace(trace);
        let selection: AgentCredentialSelection;
        if (traced.kind === 'legacy' || (traced.kind === 'platform' && !hasCCData)) {
          selection = fromLegacy(await legacy(), profile.agentType, input.projectId);
        } else if (traced.kind === 'platform') {
          selection = { kind: 'none' };
        } else {
          selection = traced;
        }
        let credentialId: string | null = null;
        if (selection.kind === 'credential') credentialId = selection.credentialId;
        else if (selection.kind === 'halted' && selection.configurationId) {
          credentialId = configurationCredential.get(selection.configurationId) ?? null;
        }
        return {
          profileId: profile.id,
          agentType: profile.agentType,
          selection,
          credentialName: credentialId ? (names.get(credentialId) ?? null) : null,
        };
      } catch (error) {
        log.warn('agent_credential_selection.profile_failed', {
          profileId: profile.id,
          agentType: profile.agentType,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          profileId: profile.id,
          agentType: profile.agentType,
          selection: { kind: 'unknown' },
          credentialName: null,
        };
      }
    })
  );
}
