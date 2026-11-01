/**
 * The agent profile a run uses, as the credential resolver needs it: which
 * profile's pins to consult, and which agent type the run actually starts.
 *
 * Every place that resolves an agent credential (the agent-key callback,
 * provider-limit admission, the AI proxy passthrough) builds this context the
 * same way, so they cannot pick different accounts for one run.
 */
import { and, eq, isNull, or } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import { log } from '../../lib/logger';
import { resolveWorkspaceRuntimeAssetContext } from '../workspace-runtime-assets';

type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface ProfileCredentialContext {
  profileId: string;
  /** `skill.agentType ?? profile.agentType`: a profile pin applies only to this agent. */
  agentType: string;
}

/**
 * Validate the run's profile and skill and derive the profile context.
 *
 * A profile is valid when it belongs to the run's project, or is the user's own
 * global profile (no project), matching `validateProfileId` in
 * `workspace-runtime-assets.ts`. A profile that is not valid for this run has no
 * pins that may apply to it, so this returns null and resolution continues at
 * the project tier.
 */
export async function resolveProfileCredentialContext(
  db: Db,
  input: {
    userId: string;
    projectId: string | null;
    profileId: string | null | undefined;
    skillId?: string | null;
  }
): Promise<ProfileCredentialContext | null> {
  const profileId = input.profileId?.trim();
  if (!profileId) return null;

  const ownGlobalProfile = and(
    isNull(schema.agentProfiles.projectId),
    eq(schema.agentProfiles.userId, input.userId)
  );
  const [profileRows, skillRows] = await Promise.all([
    db
      .select({ agentType: schema.agentProfiles.agentType })
      .from(schema.agentProfiles)
      .where(
        and(
          eq(schema.agentProfiles.id, profileId),
          input.projectId
            ? or(eq(schema.agentProfiles.projectId, input.projectId), ownGlobalProfile)
            : ownGlobalProfile
        )
      )
      .limit(1),
    input.skillId && input.projectId
      ? db
          .select({ agentType: schema.skills.agentType })
          .from(schema.skills)
          .where(
            and(eq(schema.skills.id, input.skillId), eq(schema.skills.projectId, input.projectId))
          )
          .limit(1)
      : Promise.resolve([]),
  ]);

  const profile = profileRows[0];
  if (!profile) {
    log.warn('cc.profile_context.profile_not_valid_for_run', {
      userId: input.userId,
      projectId: input.projectId,
      profileId,
      action: 'profile_tier_skipped',
    });
    return null;
  }
  return { profileId, agentType: skillRows[0]?.agentType ?? profile.agentType };
}

/**
 * Profile context for a workspace's agent session: the same session → task →
 * workspace-hint resolution the runtime assets use
 * (`resolveWorkspaceRuntimeAssetContext`), so the credential and the profile's env
 * vars always come from one profile.
 */
export async function resolveSessionProfileCredentialContext(
  db: Db,
  input: { workspaceId: string; agentSessionId?: string | null }
): Promise<ProfileCredentialContext | null> {
  const runtime = await resolveWorkspaceRuntimeAssetContext(db, input);
  return resolveProfileCredentialContext(db, {
    userId: runtime.userId,
    projectId: runtime.projectId,
    profileId: runtime.agentProfileId,
    skillId: runtime.skillId,
  });
}
