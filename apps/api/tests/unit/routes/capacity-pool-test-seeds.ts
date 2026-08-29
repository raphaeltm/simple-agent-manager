import type Database from 'better-sqlite3';

const SEEDED_AT = '2026-08-28T00:00:00.000Z';

export function seedUser(sqlite: Database.Database, id: string, role = 'user') {
  sqlite
    .prepare(
      `INSERT INTO users (id, email, role, status)
       VALUES (?, ?, ?, 'active')`
    )
    .run(id, `${id}@example.com`, role);
}

export function seedProjectWithMember(
  sqlite: Database.Database,
  input: { projectId: string; userId: string; role: string }
) {
  sqlite
    .prepare(
      `INSERT INTO projects (
        id, user_id, name, normalized_name, installation_id, repository,
        default_branch, default_provider, default_location, default_vm_size,
        status, created_by
       )
       VALUES (?, ?, 'Capacity Project', 'capacity-project', 'installation-1',
        'acme/capacity-project', 'main', 'hetzner', 'fsn1', 'small', 'active', ?)`
    )
    .run(input.projectId, input.userId, input.userId);
  sqlite
    .prepare(
      `INSERT INTO project_members (project_id, user_id, role, status)
       VALUES (?, ?, ?, 'active')`
    )
    .run(input.projectId, input.userId, input.role);
}

export function seedCloudCredential(
  sqlite: Database.Database,
  input: {
    id: string;
    userId: string;
    projectId?: string | null;
    provider?: string;
    active?: boolean;
  }
) {
  sqlite
    .prepare(
      `INSERT INTO credentials (
        id, user_id, project_id, provider, credential_type, credential_kind,
        is_active, encrypted_token, iv, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, 'cloud-provider', 'api-key', ?, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.userId,
      input.projectId ?? null,
      input.provider ?? 'hetzner',
      input.active === false ? 0 : 1,
      `encrypted-token-for-${input.id}`,
      `iv-for-${input.id}`,
      SEEDED_AT,
      SEEDED_AT
    );
}

export function seedPlatformCloudCredential(
  sqlite: Database.Database,
  id = 'platform-cloud-1'
) {
  sqlite
    .prepare(
      `INSERT INTO platform_credentials (
        id, credential_type, provider, agent_type, credential_kind, label,
        encrypted_token, iv, is_enabled, created_by, created_at, updated_at
       )
       VALUES (?, 'cloud-provider', 'hetzner', NULL, 'api-key', 'Platform Hetzner',
        ?, ?, 1, 'superadmin-1', ?, ?)`
    )
    .run(id, `platform-encrypted-token-for-${id}`, `platform-iv-for-${id}`, SEEDED_AT, SEEDED_AT);
}
