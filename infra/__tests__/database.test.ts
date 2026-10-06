import { describe, it, expect, beforeAll } from 'vitest';
import { findRegisteredResource, getOutputValue } from './setup';

describe('D1 Database Resource', () => {
  let databaseModule: typeof import('../resources/database');
  let configModule: typeof import('../resources/config');

  beforeAll(async () => {
    databaseModule = await import('../resources/database');
    configModule = await import('../resources/config');
  });

  it('exports main database outputs consumed by deployment scripts', async () => {
    const id = await getOutputValue(databaseModule.databaseId);
    const name = await getOutputValue(databaseModule.databaseName);

    expect(id).toBe(`${configModule.prefix}-database-test-id`);
    expect(name).toBe(`${configModule.prefix}-${configModule.stack}`);
  });

  it('registers the main D1 database with account wiring and readReplication ignored', () => {
    const database = findRegisteredResource(
      `${configModule.prefix}-database`,
      'cloudflare:index/d1Database:D1Database'
    );

    expect(database.inputs).toMatchObject({
      accountId: 'test-account-id-00000000000000000000',
      name: `${configModule.prefix}-${configModule.stack}`,
    });
    expect(database.options.ignoreChanges).toEqual(['readReplication']);
  });

  it('registers the observability D1 database with account wiring and readReplication ignored', async () => {
    const observabilityDatabase = findRegisteredResource(
      `${configModule.prefix}-observability`,
      'cloudflare:index/d1Database:D1Database'
    );

    expect(observabilityDatabase.inputs).toMatchObject({
      accountId: 'test-account-id-00000000000000000000',
      name: `${configModule.prefix}-observability-${configModule.stack}`,
    });
    expect(observabilityDatabase.options.ignoreChanges).toEqual(['readReplication']);
    await expect(getOutputValue(databaseModule.observabilityDatabaseName)).resolves.toBe(
      `${configModule.prefix}-observability-${configModule.stack}`
    );
  });
});
