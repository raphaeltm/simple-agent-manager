import { readFileSync } from 'node:fs';

import { SYSTEM_INSTALLATION_ID, SYSTEM_USER_ID } from '@simple-agent-manager/shared';
import { describe, expect, it } from 'vitest';

const read = (relative: string) =>
  readFileSync(new URL(`../../../src/${relative}`, import.meta.url), 'utf8');

/**
 * The system user and placeholder installation ids are fixed by migrations, and a few places must
 * repeat them as SQL literals (Drizzle index predicates cannot import a runtime constant). Pin
 * every copy to the shared constants so they cannot drift apart.
 */
describe('migration-seeded system row ids', () => {
  it('seeds the system user and placeholder installation with the shared constant ids', () => {
    expect(read('db/migrations/0043_trial_foundation.sql')).toContain(`'${SYSTEM_USER_ID}',`);
    const installation = read('db/migrations/0045_trial_sentinel_installation.sql');
    expect(installation).toContain(`'${SYSTEM_INSTALLATION_ID}',`);
    expect(installation).toContain(`'${SYSTEM_USER_ID}',`);
  });

  it('excludes the same system user id in the schema and migration uniqueness predicates', () => {
    const predicate = `user_id != '${SYSTEM_USER_ID}'`;
    expect(read('db/schema.ts')).toContain(predicate);
    expect(read('db/migrations/0046_trial_projects_unique_index_exclude_sentinel.sql')).toContain(
      predicate
    );
  });
});
