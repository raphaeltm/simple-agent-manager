/**
 * Deployment volume lifecycle service.
 *
 * Orchestrates provider-agnostic volume operations (create/attach/detach/delete)
 * through the shared Provider interface. All provider calls go through
 * `createProviderForUser()` — no provider-specific branches here.
 */

import type { Provider, VolumeInstance } from '@simple-agent-manager/providers';
import {
  SAM_VOLUME_FILESYSTEM_FORMAT,
  SAM_VOLUME_MOUNT_PATH_TEMPLATE,
} from '@simple-agent-manager/providers';
import type { DeploymentManifest } from '@simple-agent-manager/shared';
import type { CredentialProvider } from '@simple-agent-manager/shared';
import { and, eq } from 'drizzle-orm';
import type { drizzle } from 'drizzle-orm/d1';

import type { DeploymentVolumeRow } from '../db/schema';
import * as schema from '../db/schema';
import type { Env } from '../env';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { ulid } from '../lib/ulid';
import { createProviderForUser } from './provider-credentials';

// =============================================================================
// Helpers
// =============================================================================

/** Resolve the host mount path for an environment's volumes. */
export function resolveVolumeMountRoot(environmentId: string): string {
  const base = SAM_VOLUME_MOUNT_PATH_TEMPLATE.replace('{environmentId}', environmentId);
  // Template ends with '/', append 'volumes'
  return `${base}volumes`;
}

async function getProviderForUser(
  db: ReturnType<typeof drizzle>,
  userId: string,
  env: Env,
  targetProvider?: CredentialProvider,
): Promise<{ provider: Provider; providerName: CredentialProvider }> {
  const result = await createProviderForUser(db, userId, getCredentialEncryptionKey(env), env, targetProvider);
  if (!result) {
    throw new Error('No cloud provider credential found. Connect a cloud provider in Settings.');
  }
  return { provider: result.provider, providerName: result.providerName };
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

function sizeHintToGb(sizeHintMb: number | undefined, minSizeGb: number | undefined): number {
  const hintedGb = sizeHintMb ? Math.ceil(sizeHintMb / 1024) : 1;
  return Math.max(hintedGb, minSizeGb ?? 1);
}

export async function createEnvironmentVolume(
  db: ReturnType<typeof drizzle>,
  env: Env,
  userId: string,
  opts: CreateVolumeOptions,
): Promise<DeploymentVolumeRow> {
  const { provider, providerName } = await getProviderForUser(db, userId, env, opts.targetProvider);

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

  await db.insert(schema.deploymentVolumes).values(row);

  return { ...row, id, createdAt: now, updatedAt: now } as DeploymentVolumeRow;
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
  },
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
  },
): Promise<DeploymentVolumeRow[]> {
  const declarations = Object.entries(opts.volumes);
  if (declarations.length === 0) {
    return [];
  }

  const existing = await listEnvironmentVolumes(db, opts.environmentId);
  const existingByName = new Map(existing.map((volume) => [volume.name, volume]));
  const { provider } = await getProviderForUser(db, userId, env, opts.targetProvider);
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
  environmentId: string,
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
): Promise<VolumeMountDescriptor[]> {
  const volumes = await listEnvironmentVolumes(db, environmentId);
  const mountRoot = resolveVolumeMountRoot(environmentId);
  return volumes
    .filter((volume) => volume.attachedServerId)
    .map((volume) => ({
      name: volume.name,
      mountRoot,
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
): Promise<void> {
  const rows = await db
    .select()
    .from(schema.deploymentVolumes)
    .where(
      and(
        eq(schema.deploymentVolumes.id, volumeId),
        eq(schema.deploymentVolumes.environmentId, environmentId),
      ),
    )
    .limit(1);

  const vol = rows[0];
  if (!vol) {
    throw new Error('Volume not found');
  }

  if (vol.attachedServerId) {
    throw new Error('Cannot delete an attached volume. Detach it first.');
  }

  const { provider } = await getProviderForUser(db, userId, env, vol.providerName as CredentialProvider);

  // Provider deleteVolume is idempotent (no error on 404)
  await provider.deleteVolume({
    volumeId: vol.providerVolumeId,
    location: vol.location,
  });

  await db
    .delete(schema.deploymentVolumes)
    .where(eq(schema.deploymentVolumes.id, volumeId));
}

// =============================================================================
// Attach all environment volumes to a server
// =============================================================================

export async function attachEnvironmentVolumes(
  db: ReturnType<typeof drizzle>,
  env: Env,
  userId: string,
  environmentId: string,
  serverId: string,
  serverLocation: string,
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
        `Volumes and servers must be co-located.`,
      );
    }
  }

  // Use the provider from the first volume (all same environment = same provider)
  const firstVolume = volumes[0]!;
  const { provider } = await getProviderForUser(db, userId, env, firstVolume.providerName as CredentialProvider);

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
        `Detach it first before attaching to a new server.`,
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
  environmentId: string,
): Promise<DeploymentVolumeRow[]> {
  const rows = await db
    .select({
      nodeId: schema.deploymentEnvironments.nodeId,
      location: schema.deploymentEnvironments.location,
      providerInstanceId: schema.nodes.providerInstanceId,
      vmLocation: schema.nodes.vmLocation,
    })
    .from(schema.deploymentEnvironments)
    .leftJoin(schema.nodes, eq(schema.deploymentEnvironments.nodeId, schema.nodes.id))
    .where(eq(schema.deploymentEnvironments.id, environmentId))
    .limit(1);

  const placement = rows[0];
  if (!placement?.nodeId) {
    throw new Error(`Deployment environment "${environmentId}" is not linked to a node`);
  }
  if (!placement.providerInstanceId) {
    throw new Error(`Deployment node "${placement.nodeId}" does not have a provider instance id yet`);
  }
  const serverLocation = placement.location ?? placement.vmLocation;
  if (!serverLocation) {
    throw new Error(`Deployment node "${placement.nodeId}" does not have a volume attachment location`);
  }

  return attachEnvironmentVolumes(
    db,
    env,
    userId,
    environmentId,
    placement.providerInstanceId,
    serverLocation,
  );
}

// =============================================================================
// Detach all environment volumes from a server
// =============================================================================

export async function detachEnvironmentVolumes(
  db: ReturnType<typeof drizzle>,
  env: Env,
  userId: string,
  environmentId: string,
  serverId: string,
): Promise<DeploymentVolumeRow[]> {
  const volumes = await db
    .select()
    .from(schema.deploymentVolumes)
    .where(
      and(
        eq(schema.deploymentVolumes.environmentId, environmentId),
        eq(schema.deploymentVolumes.attachedServerId, serverId),
      ),
    );

  if (volumes.length === 0) {
    return [];
  }

  const firstVolume = volumes[0]!;
  const { provider } = await getProviderForUser(db, userId, env, firstVolume.providerName as CredentialProvider);

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
