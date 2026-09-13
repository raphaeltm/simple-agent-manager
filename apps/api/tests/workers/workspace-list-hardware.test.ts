import type { WorkspaceResponse } from '@simple-agent-manager/shared';
import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { crudRoutes } from '../../src/routes/workspaces/crud';
import { seedNode, seedUser, seedWorkspace } from './helpers/seed-d1';

const prefix = `workspace-list-${Date.now()}`;
const userId = `${prefix}-owner`;
const otherUserId = `${prefix}-other`;
const nodeId = `${prefix}-native`;
const legacyNodeId = `${prefix}-legacy`;
const workspaceId = `${prefix}-workspace`;

// Exercise the registered GET handler with real migrated D1. Authentication is
// supplied at its request-context boundary; no query or response mapper is mocked.
const listHandler = crudRoutes.routes
  .filter((route) => route.method === 'GET' && route.path === '/')
  .at(-1)!.handler;
const app = new Hono<{ Bindings: Env }>();
app.use('*', async (c, next) => {
  c.set('auth', {
    user: {
      id: userId, email: `${userId}@example.com`, name: null, avatarUrl: null,
      role: 'user', status: 'active',
    },
    session: { id: null, token: null, expiresAt: new Date(Date.now() + 60_000) },
  });
  await next();
});
app.get('/api/workspaces', listHandler);

beforeAll(async () => {
  await seedUser(userId);
  await seedUser(otherUserId);
  await seedNode(nodeId, userId, { vmSize: 'small' });
  await seedNode(legacyNodeId, userId);
  await env.DATABASE.prepare(`UPDATE nodes SET cloud_provider = 'hetzner',
    provider_instance_type = 'cx43', provider_instance_vcpu_count = 8,
    provider_instance_memory_mb = 16384, provider_instance_disk_gb = 160,
    provider_instance_boot_disk_size_gb = 180, provider_instance_architecture = 'x86',
    observed_provider_instance_type = 'cx53', observed_provider_instance_vcpu_count = 16,
    observed_provider_instance_memory_mb = 32768, observed_provider_instance_disk_gb = 175
    WHERE id = ?`).bind(nodeId).run();
  await seedWorkspace(workspaceId, nodeId, userId);
  await env.DATABASE.prepare(`UPDATE workspaces SET provider_instance_type = 'cx23',
    resource_requirements_json = ? WHERE id = ?`)
    .bind(JSON.stringify({ minVcpu: 1, minMemoryGb: 2 }), workspaceId).run();
  await seedWorkspace(`${prefix}-legacy-workspace`, legacyNodeId, userId);
  await seedWorkspace(`${prefix}-unassigned`, null, userId);
  await seedWorkspace(`${prefix}-deleted`, nodeId, userId, { status: 'deleted' });
  await seedWorkspace(`${prefix}-deleted-on-legacy`, legacyNodeId, userId, { status: 'deleted' });
  await seedNode(`${prefix}-other-node`, otherUserId);
  await seedWorkspace(`${prefix}-other-workspace`, `${prefix}-other-node`, otherUserId);
});

describe('workspace list native hardware on real D1', () => {
  it('lists native, legacy and unassigned workspaces without exceeding D1 result columns', async () => {
    const response = await app.request('/api/workspaces', {}, env as Env);
    expect(response.status).toBe(200);
    const rows = await response.json() as WorkspaceResponse[];
    expect(rows.map((row) => row.id).sort()).toEqual([
      workspaceId, `${prefix}-legacy-workspace`, `${prefix}-unassigned`,
    ].sort());
    expect(rows.find((row) => row.id === workspaceId)).toMatchObject({
      providerInstanceType: 'cx23',
      resourceRequirementsJson: JSON.stringify({ minVcpu: 1, minMemoryGb: 2 }),
      hardware: {
        cloudProvider: 'hetzner', vmSize: 'small', providerInstanceType: 'cx43',
        providerInstanceVcpuCount: 8, providerInstanceMemoryMb: 16384, providerInstanceDiskGb: 160,
        providerInstanceBootDiskSizeGb: 180, providerInstanceArchitecture: 'x86',
        observedProviderInstanceType: 'cx53', observedProviderInstanceVcpuCount: 16,
        observedProviderInstanceMemoryMb: 32768, observedProviderInstanceDiskGb: 175,
      },
    });
    expect(rows.find((row) => row.id === `${prefix}-legacy-workspace`)?.hardware).toMatchObject({
      vmSize: 'medium', providerInstanceType: null, providerInstanceVcpuCount: null,
      observedProviderInstanceType: null, observedProviderInstanceVcpuCount: null,
    });
    expect(rows.find((row) => row.id === `${prefix}-unassigned`)).not.toHaveProperty('hardware');
  });

  it('preserves node and explicit deleted-status filtering used by node pages', async () => {
    const response = await app.request(`/api/workspaces?nodeId=${nodeId}&status=deleted`, {}, env as Env);
    expect(response.status).toBe(200);
    const rows = await response.json() as WorkspaceResponse[];
    expect(rows.map((row) => row.id)).toEqual([`${prefix}-deleted`]);
    expect(rows[0]?.hardware?.observedProviderInstanceType).toBe('cx53');
  });
});
