/**
 * Deployment volume lifecycle service.
 *
 * Orchestrates provider-agnostic volume operations (create/attach/detach/delete)
 * through the shared Provider interface. All provider calls go through
 * `createProviderForUser()` — no provider-specific branches here.
 */

import {
  type Provider,
  SAM_VOLUME_FILESYSTEM_FORMAT,
  SAM_VOLUME_MOUNT_PATH_TEMPLATE,
  type VolumeInstance,
} from '@simple-agent-manager/providers';
import {
  type CredentialProvider,
  type DeploymentManifest,
  SAM_DEPLOYMENT_VOLUME_DEFAULT_SIZE_GB,
  SAM_DEPLOYMENT_VOLUME_NAME_MESSAGE,
  SAM_DEPLOYMENT_VOLUME_NAME_PATTERN_SOURCE,
} from '@simple-agent-manager/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';
import { parse as parseYaml } from 'yaml';

import type { DeploymentVolumeRow } from '../db/schema';
import * as schema from '../db/schema';
import type { Env } from '../env';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { ulid } from '../lib/ulid';
import { createProviderForUser } from './provider-credentials';

// =============================================================================
// Helpers
// =============================================================================

export const NAMED_VOLUME_BIND_DATA_DIR = 'data';

/** Resolve the host directory under which an environment's named volume mountpoints live. */
export function resolveVolumeMountRoot(environmentId: string): string {
  const base = SAM_VOLUME_MOUNT_PATH_TEMPLATE.replace('{environmentId}', environmentId);
  // Template ends with '/', append 'volumes'
  return `${base}volumes`;
}

/** Resolve the host mountpoint for a specific named provider-backed volume. */
export function resolveNamedVolumeMountRoot(environmentId: string, volumeName: string): string {
  return `${resolveVolumeMountRoot(environmentId)}/${volumeName}`;
}

/** Resolve the host bind source exposed to containers for a named provider-backed volume. */
export function resolveNamedVolumeBindSource(environmentId: string, volumeName: string): string {
  return `${resolveNamedVolumeMountRoot(environmentId, volumeName)}/${NAMED_VOLUME_BIND_DATA_DIR}`;
}

async function getProviderForUser(
  db: ReturnType<typeof drizzle>,
  userId: string,
  env: Env,
  targetProvider?: CredentialProvider,
  projectId?: string | null
): Promise<{ provider: Provider; providerName: CredentialProvider }> {
  const result = await createProviderForUser(
    db,
    userId,
    getCredentialEncryptionKey(env),
    env,
    targetProvider,
    projectId
  );
  if (!result) {
    throw new Error('No cloud provider credential found. Connect a cloud provider in Settings.');
  }
  return { provider: result.provider, providerName: result.providerName };
}

async function getEnvironmentProjectId(
  db: ReturnType<typeof drizzle>,
  environmentId: string
): Promise<string | null> {
  const rows = await db
    .select({ projectId: schema.deploymentEnvironments.projectId })
    .from(schema.deploymentEnvironments)
    .where(eq(schema.deploymentEnvironments.id, environmentId))
    .limit(1);
  return rows[0]?.projectId ?? null;
}

// =============================================================================
// Create
// =============================================================================

export interface CreateVolumeOptions {
  environmentId: string;
  name: string;
  sizeGb: number;
  location: string;
  /** Optional: target a specific provider. Falls through credential resolution if omitted. */
  targetProvider?: CredentialProvider;
}

export interface VolumeMountDescriptor {
  name: string;
  mountRoot: string;
  providerVolumeId: string;
  providerName: string;
  linuxDevice?: string;
  fsFormat: typeof SAM_VOLUME_FILESYSTEM_FORMAT;
}

export interface LinkedDeploymentNodeVolumeTarget {
  nodeId: string;
  serverId: string;
  location: string;
}

const VOLUME_NAME_RE = new RegExp(SAM_DEPLOYMENT_VOLUME_NAME_PATTERN_SOURCE);

function assertSafeVolumeName(name: string): void {
  if (!VOLUME_NAME_RE.test(name)) {
    throw new Error(SAM_DEPLOYMENT_VOLUME_NAME_MESSAGE);
  }
}

function sizeHintToGb(sizeHintMb: number | undefined, minSizeGb: number | undefined): number {
  const hintedGb = sizeHintMb
    ? Math.ceil(sizeHintMb / 1024)
    : SAM_DEPLOYMENT_VOLUME_DEFAULT_SIZE_GB;
  return Math.max(hintedGb, minSizeGb ?? SAM_DEPLOYMENT_VOLUME_DEFAULT_SIZE_GB);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDeploymentVolumeUniqueConstraintError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('idx_deployment_volumes_env_name') ||
    message.includes('deployment_volumes.environment_id') ||
    message.includes('deployment_volumes.name') ||
    (message.includes('UNIQUE constraint failed') && message.includes('deployment_volumes'))
  );
}

function releaseManifestVolumeNames(manifestJson: string): Set<string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson);
  } catch {
    return null;
  }

  if (!isPlainObject(parsed)) {
    return null;
  }

  if (isPlainObject(parsed.volumes)) {
    return new Set(Object.keys(parsed.volumes));
  }

  if (typeof parsed.composeYaml === 'string') {
    try {
      const compose = parseYaml(parsed.composeYaml);
      if (isPlainObject(compose) && isPlainObject(compose.volumes)) {
        return new Set(Object.keys(compose.volumes));
      }
    } catch {
      return null;
    }
  }

  return new Set();
}

async function findEnvironmentVolumeByName(
  db: ReturnType<typeof drizzle>,
  environmentId: string,
  name: string
): Promise<DeploymentVolumeRow | null> {
  const volumes = await listEnvironmentVolumes(db, environmentId);
  return volumes.find((volume) => volume.name === name) ?? null;
}

async function cleanupProviderVolumeAfterInsertFailure(
  provider: Provider,
  volumeResult: VolumeInstance,
  location: string,
  insertErr: unknown
): Promise<void> {
  try {
    await provider.deleteVolume({ volumeId: volumeResult.id, location });
  } catch (cleanupErr) {
    const insertMessage = insertErr instanceof Error ? insertErr.message : String(insertErr);
    const cleanupMessage = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
    throw new Error(
      `Created provider volume ${volumeResult.id}, but failed to record it in SAM (${insertMessage}) and cleanup also failed (${cleanupMessage}). Manual provider cleanup is required.`
    );
  }
}

export async function createEnvironmentVolume(
  db: ReturnType<typeof drizzle>,
  env: Env,
  userId: string,
  opts: CreateVolumeOptions
): Promise<DeploymentVolumeRow> {
  assertSafeVolumeName(opts.name);

  const projectId = await getEnvironmentProjectId(db, opts.environmentId);
  const { provider, providerName } = await getProviderForUser(db, userId, env, opts.targetProvider, projectId);

  // Check volume capabilities
  const caps = provider.volumeCapabilities;
  if (!caps.supported) {
    throw new Error(`Provider "${providerName}" does not support block volumes`);
  }
  if (caps.minSizeGb && opts.sizeGb < caps.minSizeGb) {
    throw new Error(`Minimum volume size for ${providerName} is ${caps.minSizeGb} GB`);
  }
  if (caps.maxSizeGb && opts.sizeGb > caps.maxSizeGb) {
    throw new Error(`Maximum volume size for ${providerName} is ${caps.maxSizeGb} GB`);
  }

  const samLabels: Record<string, string> = {
    'sam-environment': opts.environmentId,
    'sam-volume-name': opts.name,
  };

  const volumeResult: VolumeInstance = await provider.createVolume({
    name: `sam-${opts.environmentId}-${opts.name}`,
    sizeGb: opts.sizeGb,
    location: opts.location,
    labels: samLabels,
  });

  const id = ulid();
  const now = new Date().toISOString();

  const row: schema.NewDeploymentVolumeRow = {
    id,
    environmentId: opts.environmentId,
    name: opts.name,
    providerVolumeId: volumeResult.id,
    providerName,
    sizeGb: opts.sizeGb,
    location: opts.location,
    status: volumeResult.status,
    attachedServerId: volumeResult.attachedServerId ?? null,
    linuxDevice: volumeResult.linuxDevice ?? null,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await db.insert(schema.deploymentVolumes).values(row);
  } catch (err) {
    await cleanupProviderVolumeAfterInsertFailure(provider, volumeResult, opts.location, err);

    if (isDeploymentVolumeUniqueConstraintError(err)) {
      const existing = await findEnvironmentVolumeByName(db, opts.environmentId, opts.name);
      if (existing) {
        return existing;
      }
    }

    throw err;
  }

  return { ...row, id, createdAt: now, updatedAt: now } as DeploymentVolumeRow;
}

export async function markDeploymentReleaseVolumeAttachFailed(
  db: ReturnType<typeof drizzle>,
  environmentId: string,
  releaseId: string,
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const now = new Date().toISOString();

  await db
    .update(schema.deploymentReleases)
    .set({ status: 'failed' })
    .where(eq(schema.deploymentReleases.id, releaseId));
  await db
    .update(schema.deploymentEnvironments)
    .set({
      status: 'error',
      observedStatus: 'failed',
      observedErrorMessage: `Volume attach failed: ${message}`,
      updatedAt: now,
    })
    .where(eq(schema.deploymentEnvironments.id, environmentId));
}

export async function createMissingManifestVolumes(
  db: ReturnType<typeof drizzle>,
  env: Env,
  userId: string,
  opts: {
    environmentId: string;
    manifest: DeploymentManifest;
    location: string;
    targetProvider: CredentialProvider;
  }
): Promise<DeploymentVolumeRow[]> {
  return createMissingDeclaredVolumes(db, env, userId, {
    environmentId: opts.environmentId,
    volumes: opts.manifest.volumes,
    location: opts.location,
    targetProvider: opts.targetProvider,
  });
}

export async function createMissingDeclaredVolumes(
  db: ReturnType<typeof drizzle>,
  env: Env,
  userId: string,
  opts: {
    environmentId: string;
    volumes: Record<string, { sizeHintMb?: number }>;
    location: string;
    targetProvider: CredentialProvider;
  }
): Promise<DeploymentVolumeRow[]> {
  const declarations = Object.entries(opts.volumes);
  if (declarations.length === 0) {
    return [];
  }

  const existing = await listEnvironmentVolumes(db, opts.environmentId);
  const existingByName = new Map(existing.map((volume) => [volume.name, volume]));
  const projectId = await getEnvironmentProjectId(db, opts.environmentId);
  const { provider } = await getProviderForUser(db, userId, env, opts.targetProvider, projectId);
  const minSizeGb = provider.volumeCapabilities.minSizeGb;

  const results: DeploymentVolumeRow[] = [...existing];
  for (const [name, declaration] of declarations) {
    const current = existingByName.get(name);
    if (current) {
      continue;
    }
    const created = await createEnvironmentVolume(db, env, userId, {
      environmentId: opts.environmentId,
      name,
      sizeGb: sizeHintToGb(declaration.sizeHintMb, minSizeGb),
      location: opts.location,
      targetProvider: opts.targetProvider,
    });
    results.push(created);
  }

  return results.filter((volume) => opts.volumes[volume.name] !== undefined);
}

// =============================================================================
// List
// =============================================================================

export async function listEnvironmentVolumes(
  db: ReturnType<typeof drizzle>,
  environmentId: string
): Promise<DeploymentVolumeRow[]> {
  return db
    .select()
    .from(schema.deploymentVolumes)
    .where(eq(schema.deploymentVolumes.environmentId, environmentId))
    .orderBy(schema.deploymentVolumes.createdAt);
}

export async function buildVolumeMountDescriptors(
  db: ReturnType<typeof drizzle>,
  environmentId: string,
  attachedServerId?: string
): Promise<VolumeMountDescriptor[]> {
  const volumes = await listEnvironmentVolumes(db, environmentId);
  return volumes
    .filter((volume) =>
      attachedServerId === undefined
        ? Boolean(volume.attachedServerId)
        : volume.attachedServerId === attachedServerId
    )
    .map((volume) => ({
      name: volume.name,
      mountRoot: resolveNamedVolumeMountRoot(environmentId, volume.name),
      providerVolumeId: volume.providerVolumeId,
      providerName: volume.providerName,
      ...(volume.linuxDevice ? { linuxDevice: volume.linuxDevice } : {}),
      fsFormat: SAM_VOLUME_FILESYSTEM_FORMAT,
    }));
}

// =============================================================================
// Delete
// =============================================================================

export async function deleteEnvironmentVolume(
  db: ReturnType<typeof drizzle>,
  env: Env,
  userId: string,
  volumeId: string,
  environmentId: string,
  opts: { allowLatestReleaseDeclaredVolume?: boolean } = {}
): Promise<void> {
  const rows = await db
    .select()
    .from(schema.deploymentVolumes)
    .where(
      and(
        eq(schema.deploymentVolumes.id, volumeId),
        eq(schema.deploymentVolumes.environmentId, environmentId)
      )
    )
    .limit(1);

  const vol = rows[0];
  if (!vol) {
    throw new Error('Volume not found');
  }

  if (vol.attachedServerId) {
    throw new Error('Cannot delete an attached volume. Detach it first.');
  }

  if (!opts.allowLatestReleaseDeclaredVolume) {
    const releaseRows = await db
      .select({ manifest: schema.deploymentReleases.manifest })
      .from(schema.deploymentReleases)
      .where(eq(schema.deploymentReleases.environmentId, environmentId))
      .orderBy(desc(schema.deploymentReleases.version))
      .limit(1);
    const latestManifest = releaseRows[0]?.manifest;
    if (latestManifest) {
      const declaredVolumes = releaseManifestVolumeNames(latestManifest);
      if (!declaredVolumes) {
        throw new Error(
          'Cannot delete volume because the latest release manifest could not be checked. Destroy the environment or publish a new release without this volume first.'
        );
      }
      if (declaredVolumes.has(vol.name)) {
        throw new Error(
          `Cannot delete volume "${vol.name}" because the latest release still declares it. Publish a release without this volume or destroy the environment to delete it.`
        );
      }
    }
  }

  const { provider } = await getProviderForUser(
    db,
    userId,
    env,
    vol.providerName as CredentialProvider,
    await getEnvironmentProjectId(db, environmentId)
  );

  // Provider deleteVolume is idempotent (no error on 404)
  await provider.deleteVolume({
    volumeId: vol.providerVolumeId,
    location: vol.location,
  });

  await db.delete(schema.deploymentVolumes).where(eq(schema.deploymentVolumes.id, volumeId));
}

// =============================================================================
// Attach all environment volumes to a server
// =============================================================================

export async function resolveLinkedDeploymentNodeVolumeTarget(
  db: ReturnType<typeof drizzle>,
  environmentId: string
): Promise<LinkedDeploymentNodeVolumeTarget> {
  const rows = await db
    .select({
      nodeId: schema.deploymentEnvironments.nodeId,
      location: schema.deploymentEnvironments.location,
      providerInstanceId: schema.nodes.providerInstanceId,
      vmLocation: schema.nodes.vmLocation,
      nodeRole: schema.nodes.nodeRole,
    })
    .from(schema.deploymentEnvironments)
    .leftJoin(schema.nodes, eq(schema.deploymentEnvironments.nodeId, schema.nodes.id))
    .where(eq(schema.deploymentEnvironments.id, environmentId))
    .limit(1);

  const placement = rows[0];
  if (!placement?.nodeId) {
    throw new Error(`Deployment environment "${environmentId}" is not linked to a node`);
  }
  if (placement.nodeRole && placement.nodeRole !== 'deployment') {
    throw new Error(`Node "${placement.nodeId}" is not a deployment node`);
  }
  if (!placement.providerInstanceId) {
    throw new Error(
      `Deployment node "${placement.nodeId}" does not have a provider instance id yet`
    );
  }
  const location = placement.location ?? placement.vmLocation;
  if (!location) {
    throw new Error(
      `Deployment node "${placement.nodeId}" does not have a volume attachment location`
    );
  }

  return {
    nodeId: placement.nodeId,
    serverId: placement.providerInstanceId,
    location,
  };
}

export async function attachEnvironmentVolumes(
  db: ReturnType<typeof drizzle>,
  env: Env,
  userId: string,
  environmentId: string,
  serverId: string,
  serverLocation: string
): Promise<DeploymentVolumeRow[]> {
  const volumes = await listEnvironmentVolumes(db, environmentId);

  if (volumes.length === 0) {
    return [];
  }

  // Validate co-location for all volumes
  for (const vol of volumes) {
    if (vol.location !== serverLocation) {
      throw new Error(
        `Volume "${vol.name}" is in location "${vol.location}" but server is in "${serverLocation}". ` +
          `Volumes and servers must be co-located.`
      );
    }
  }

  // Use the provider from the first volume (all same environment = same provider)
  const firstVolume = volumes[0]!;
  const { provider } = await getProviderForUser(
    db,
    userId,
    env,
    firstVolume.providerName as CredentialProvider,
    await getEnvironmentProjectId(db, environmentId)
  );

  const now = new Date().toISOString();
  const results: DeploymentVolumeRow[] = [];

  for (const vol of volumes) {
    if (vol.attachedServerId === serverId) {
      // Already attached to this server — skip
      results.push(vol);
      continue;
    }

    if (vol.attachedServerId) {
      throw new Error(
        `Volume "${vol.name}" is already attached to server "${vol.attachedServerId}". ` +
          `Detach it first before attaching to a new server.`
      );
    }

    const attached: VolumeInstance = await provider.attachVolume({
      volumeId: vol.providerVolumeId,
      serverId,
      location: vol.location,
    });

    await db
      .update(schema.deploymentVolumes)
      .set({
        status: attached.status,
        attachedServerId: attached.attachedServerId ?? serverId,
        linuxDevice: attached.linuxDevice ?? null,
        updatedAt: now,
      })
      .where(eq(schema.deploymentVolumes.id, vol.id));

    results.push({
      ...vol,
      status: attached.status,
      attachedServerId: attached.attachedServerId ?? serverId,
      linuxDevice: attached.linuxDevice ?? null,
      updatedAt: now,
    });
  }

  return results;
}

export async function attachEnvironmentVolumesToLinkedNode(
  db: ReturnType<typeof drizzle>,
  env: Env,
  userId: string,
  environmentId: string
): Promise<DeploymentVolumeRow[]> {
  const target = await resolveLinkedDeploymentNodeVolumeTarget(db, environmentId);

  return attachEnvironmentVolumes(db, env, userId, environmentId, target.serverId, target.location);
}

export async function detachEnvironmentVolumesFromLinkedNode(
  db: ReturnType<typeof drizzle>,
  env: Env,
  userId: string,
  environmentId: string
): Promise<DeploymentVolumeRow[]> {
  const target = await resolveLinkedDeploymentNodeVolumeTarget(db, environmentId);
  return detachEnvironmentVolumes(db, env, userId, environmentId, target.serverId);
}

// =============================================================================
// Detach all environment volumes from a server
// =============================================================================

export async function detachEnvironmentVolumes(
  db: ReturnType<typeof drizzle>,
  env: Env,
  userId: string,
  environmentId: string,
  serverId: string
): Promise<DeploymentVolumeRow[]> {
  const volumes = await db
    .select()
    .from(schema.deploymentVolumes)
    .where(
      and(
        eq(schema.deploymentVolumes.environmentId, environmentId),
        eq(schema.deploymentVolumes.attachedServerId, serverId)
      )
    );

  if (volumes.length === 0) {
    return [];
  }

  const firstVolume = volumes[0]!;
  const { provider } = await getProviderForUser(
    db,
    userId,
    env,
    firstVolume.providerName as CredentialProvider,
    await getEnvironmentProjectId(db, environmentId)
  );

  const now = new Date().toISOString();
  const results: DeploymentVolumeRow[] = [];

  for (const vol of volumes) {
    // Provider detachVolume is idempotent
    await provider.detachVolume({
      volumeId: vol.providerVolumeId,
      serverId,
      location: vol.location,
    });

    await db
      .update(schema.deploymentVolumes)
      .set({
        status: 'available',
        attachedServerId: null,
        linuxDevice: null,
        updatedAt: now,
      })
      .where(eq(schema.deploymentVolumes.id, vol.id));

    results.push({
      ...vol,
      status: 'available',
      attachedServerId: null,
      linuxDevice: null,
      updatedAt: now,
    });
  }

  return results;
}
