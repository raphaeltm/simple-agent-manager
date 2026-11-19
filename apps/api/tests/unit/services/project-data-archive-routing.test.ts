import {
  assertArchiveJournalTransition,
  assertExactWriteAllowed,
  resolveExactReadOwner,
} from '@simple-agent-manager/project-data/internal/client/project-data-archive-routing';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

function envWithLocation(row: Record<string, unknown> | null): Env {
  const first = vi.fn(async () => row);
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({ bind, first }));
  return { DATABASE: { prepare } } as unknown as Env;
}

describe('ProjectData archive routing', () => {
  it('routes missing location rows to the root owner', async () => {
    const owner = await resolveExactReadOwner(envWithLocation(null), 'project-1', 'session-1');
    expect(owner).toMatchObject({
      state: 'root',
      kind: 'root',
      ownerName: 'project-1',
      generation: 0,
    });
  });

  it('reads an in-flight migration from the root until the flip', async () => {
    const owner = await resolveExactReadOwner(
      envWithLocation({
        project_id: 'project-1',
        session_id: 'session-1',
        location_state: 'migrating',
        owner_kind: 'archive_shard',
        owner_name: 'project-1:archive:g1:s0',
        generation: 1,
        migration_id: 'migration-1',
        routing_schema_version: 1,
      }),
      'project-1',
      'session-1'
    );
    expect(owner).toMatchObject({
      state: 'migrating',
      kind: 'root',
      ownerName: 'project-1',
      generation: 0,
      migrationId: 'migration-1',
    });
  });

  it('still fences writes while a migration is in flight', async () => {
    await expect(
      assertExactWriteAllowed(
        envWithLocation({
          project_id: 'project-1',
          session_id: 'session-1',
          location_state: 'migrating',
          owner_kind: 'archive_shard',
          owner_name: 'project-1:archive:g1:s0',
          generation: 1,
          migration_id: 'migration-1',
          routing_schema_version: 1,
        }),
        'project-1',
        'session-1',
        'persistMessage'
      )
    ).rejects.toMatchObject({ reason: 'exact_write_owner_not_root' });
  });

  it('fails closed for frozen locations', async () => {
    await expect(
      resolveExactReadOwner(
        envWithLocation({
          project_id: 'project-1',
          session_id: 'session-1',
          location_state: 'frozen',
          owner_kind: 'archive_shard',
          owner_name: 'project-1:archive:g1:s0',
          generation: 1,
          migration_id: 'migration-1',
          routing_schema_version: 1,
        }),
        'project-1',
        'session-1'
      )
    ).rejects.toMatchObject({ reason: 'exact_read_owner_not_publishable' });
  });

  it('rejects ambiguous published archive locations instead of falling back', async () => {
    await expect(
      resolveExactReadOwner(
        envWithLocation({
          project_id: 'project-1',
          session_id: 'session-1',
          location_state: 'archive_shard',
          owner_kind: 'archive_shard',
          owner_name: 'project-1:archive:g0:s0',
          generation: 0,
          migration_id: 'migration-1',
          routing_schema_version: 1,
        }),
        'project-1',
        'session-1'
      )
    ).rejects.toMatchObject({ reason: 'ambiguous_archive_location' });
  });

  it('fences writes once a session is published to an archive shard', async () => {
    await expect(
      assertExactWriteAllowed(
        envWithLocation({
          project_id: 'project-1',
          session_id: 'session-1',
          location_state: 'archive_shard',
          owner_kind: 'archive_shard',
          owner_name: 'project-1:archive:g1:s0',
          generation: 1,
          migration_id: 'migration-1',
          routing_schema_version: 1,
        }),
        'project-1',
        'session-1',
        'persistMessage'
      )
    ).rejects.toMatchObject({ reason: 'exact_write_owner_not_root' });
  });

  it('enumerates monotonic journal transitions including idempotent source_deleted proof', () => {
    expect(() => assertArchiveJournalTransition('source_deleted', 'source_deleted')).not.toThrow();
    expect(() => assertArchiveJournalTransition('source_deleted', 'published')).not.toThrow();
    expect(() => assertArchiveJournalTransition('source_deleted', 'target_sealed')).toThrow(
      /Invalid ProjectData archive journal transition/
    );
  });
});
