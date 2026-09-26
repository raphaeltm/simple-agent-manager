import {
  type AgentProfileRuntime,
  type CredentialSource,
  DEFAULT_VM_SIZE,
  DEFAULT_WORKSPACE_PROFILE,
  VALID_WORKSPACE_PROFILES,
  type VMSize,
  type WorkspaceProfile,
} from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { expectJsonRecord } from '../lib/runtime-validation';
import type {
  TaskStartPlacementInput,
  TaskStartPlacementWithCredential,
} from './placement-resolver';
import {
  parseLegacyVmSize,
  type PersistedTaskResourcePlanReadResult,
  readPersistedTaskResourcePlan,
  ResourceRequirementsValidationError,
} from './resource-requirements-input';
import type { RecoveryContext } from './session-recovery-context';
import type { SessionRecoveryOptions } from './session-recovery-eviction';
import { resolveRecoveryLocationIntent } from './session-recovery-location';
import type { Db } from './session-recovery-task-guard';

export type RecoveryPlacementResolution = TaskStartPlacementWithCredential;

export function asVmSize(value: string | null | undefined): VMSize {
  return value === 'small' || value === 'medium' || value === 'large' ? value : DEFAULT_VM_SIZE;
}

export function asWorkspaceProfile(value: string | null | undefined): WorkspaceProfile {
  return (VALID_WORKSPACE_PROFILES as readonly string[]).includes(value ?? '')
    ? (value as WorkspaceProfile)
    : DEFAULT_WORKSPACE_PROFILE;
}

function asCredentialSource(value: string | null | undefined): CredentialSource {
  return value === 'project' || value === 'platform' || value === 'self-hosted' ? value : 'user';
}

function asAgentProfileRuntime(value: string | null | undefined): AgentProfileRuntime | null {
  return value === 'vm' || value === 'cf-container' ? value : null;
}

export function snapshotAgentType(snapshot: schema.SessionSnapshot): string | null {
  if (!snapshot.manifestJson) return null;
  try {
    const manifest = expectJsonRecord(
      JSON.parse(snapshot.manifestJson),
      'session_recovery.snapshot_manifest'
    );
    return typeof manifest.agentType === 'string' && manifest.agentType.trim()
      ? manifest.agentType.trim()
      : null;
  } catch {
    return null;
  }
}
/**
 * The placement request a wake makes. It only builds the request; the canonical
 * resolvers (`resolveTaskStartPlacement` and credential attribution) run in
 * `session-recovery.ts`, next to the recovery-task writer they vouch for.
 */
export async function buildRecoveryPlacementInput(
  db: Db,
  env: Env,
  context: RecoveryContext,
  taskId: string,
  options: SessionRecoveryOptions = {}
): Promise<TaskStartPlacementInput | { error: string; errorKind: 'placement' }> {
  const profile = context.workspace.agentProfileHint
    ? await db
        .select()
        .from(schema.agentProfiles)
        .where(eq(schema.agentProfiles.id, context.workspace.agentProfileHint))
        .get()
    : null;
  const sourceTask = context.sourceTask;

  // Wake reuses the ORIGINAL run's canonical resource plan, read through the
  // one shared reader. It used to `JSON.parse(sourceTask.resourceRequirementsJson)`
  // into the `task` layer alone, which silently dropped every inherited layer
  // (trigger / skill / agent-profile / project / user), ignored the persisted
  // `resolvedReservation`, discarded the compatibility provenance recorded when
  // a legacy size was translated, and threw an unhandled SyntaxError on a
  // malformed stored value. Recomputing the layers from TODAY's project and
  // profile defaults would also let a default changed since the session went to
  // sleep silently re-size the woken workspace.
  let storedPlan: PersistedTaskResourcePlanReadResult;
  try {
    storedPlan = readPersistedTaskResourcePlan({
      taskId: sourceTask?.id ?? taskId,
      triggerId: sourceTask?.triggerId ?? null,
      skillId: sourceTask?.skillId ?? null,
      agentProfileId: sourceTask?.agentProfileHint ?? context.workspace.agentProfileHint ?? null,
      projectId: context.project.id,
      userId: context.snapshot.userId,
      resourceRequirementPlanJson: sourceTask?.resourceRequirementPlanJson ?? null,
      resourceRequirementsJson: sourceTask?.resourceRequirementsJson ?? null,
      resourceRequirementsSource: sourceTask?.resourceRequirementsSource ?? null,
      resolvedReservationJson: sourceTask?.resolvedReservationJson ?? null,
      requestedVmSize: sourceTask?.requestedVmSize ?? null,
      requestedVmSizeSource: sourceTask?.requestedVmSizeSource ?? null,
    });
  } catch (error) {
    // A malformed stored intent must fail visibly. Silently falling back to
    // "no requirements" would wake the session onto whatever the current
    // defaults happen to be, which is a scope change the user never asked for.
    if (error instanceof ResourceRequirementsValidationError) {
      log.warn('session_recovery.stored_resource_plan_invalid', {
        projectId: context.project.id,
        taskId,
        sourceTaskId: sourceTask?.id ?? null,
        reason: error.message,
      });
      return {
        error: `Stored resource requirements for this session are invalid: ${error.message}`,
        errorKind: 'placement',
      };
    }
    throw error;
  }

  // The size the ORIGINAL run resolved to, not whatever the current project
  // default resolves to now. `workspace.vmSize` is the size actually running.
  const persistedVmSize =
    storedPlan.requestedVmSize ??
    parseLegacyVmSize(sourceTask?.requestedVmSize ?? null) ??
    asVmSize(context.workspace.vmSize);
  const persistedVmSizeSource = storedPlan.requestedVmSizeSource ?? 'task';
  // Human wakes, durable wakes and eviction recovery all come through here, so they share one
  // rule for the old location (`session-recovery-location.ts`).
  const locationIntent = await resolveRecoveryLocationIntent(env, context);

  return {
    entryPoint: 'session-recovery',
    taskId,
    projectId: context.project.id,
    userId: context.snapshot.userId,
    project: context.project,
    profile: profile
      ? {
          profileId: profile.id,
          agentType: profile.agentType,
          vmSizeOverride: profile.vmSizeOverride,
          provider: profile.provider,
          vmLocation: profile.vmLocation,
          workspaceProfile: profile.workspaceProfile,
          runtime: asAgentProfileRuntime(profile.runtime),
          devcontainerConfigName: profile.devcontainerConfigName,
          taskMode: profile.taskMode,
        }
      : null,
    explicit: {
      vmSize: persistedVmSize,
      vmSizeSource: persistedVmSizeSource,
      provider: null,
      // Pin the old location only when the conversation's first run explicitly asked for it.
      // Otherwise it is a preference: it still ranks hosts there first, but a capacity-pressured
      // region can no longer delete every other permitted offering and host from the wake.
      // Resources stay pinned (the persisted plan above); machine type and region do not.
      vmLocation: locationIntent === 'required' ? context.workspace.vmLocation : null,
      workspaceProfile: asWorkspaceProfile(context.workspace.workspaceProfile),
      devcontainerConfigName: context.workspace.devcontainerConfigName,
      taskMode: 'conversation',
      agentType: snapshotAgentType(context.snapshot),
      runtime: 'vm',
    },
    inheritedCredentialAttribution: {
      userId: sourceTask?.credentialAttributionUserId ?? context.snapshot.userId,
      projectId: sourceTask?.credentialAttributionProjectId ?? null,
      source: asCredentialSource(sourceTask?.credentialAttributionSource),
    },
    // A wake prefers the region it slept in. Eviction recovery does not: an evicted workspace is
    // relocated through normal placement (policy 95c3329a), so only an explicit pin applies.
    preferredVmLocation: options.evictionFence ? null : context.workspace.vmLocation,
    credentialProjectPolicy: 'current-project-unless-inherited',
    taskModeDefault: 'workspace-profile',
    // Every persisted layer, at its ORIGINAL precedence — not just `task`, and
    // not re-derived from today's project/profile rows.
    resourceRequirements: storedPlan.layers,
    // The reservation the original run actually allocated against. Reusing it
    // keeps a wake byte-identical to the run it resumes; recomputing could
    // silently re-size the workspace under a changed default.
    resolvedReservationOverride: storedPlan.resolvedReservation,
  };
}
