import { beforeAll, describe, expect, it } from 'vitest';
import { getRegisteredResources } from './setup';

type ConfigModule = typeof import('../resources/config');
type ConfigReader = ConfigModule['ConfigReader'];

class FakeConfig implements ConfigReader {
  constructor(private readonly values: Record<string, string | undefined>) {}

  get(key: string): string | undefined {
    return this.values[key];
  }

  require(key: string): string {
    const value = this.get(key);
    if (value === undefined) {
      throw new Error(`Missing required Pulumi config "${key}"`);
    }
    return value;
  }
}

function makeConfig(overrides: Record<string, string | undefined> = {}): FakeConfig {
  return new FakeConfig({
    cloudflareAccountId: 'account-123',
    cloudflareZoneId: 'zone-123',
    baseDomain: 'example.com',
    ...overrides,
  });
}

describe('infra config parsing', () => {
  let configModule: ConfigModule;

  beforeAll(async () => {
    configModule = await import('../resources/config');
  });

  it('uses stable defaults for configurable deployment policy', () => {
    const parsed = configModule.parseInfraConfig(makeConfig(), 'staging');

    expect(parsed).toMatchObject({
      accountId: 'account-123',
      zoneId: 'zone-123',
      baseDomain: 'example.com',
      stack: 'staging',
      r2Location: configModule.DEFAULT_R2_LOCATION,
      pagesProductionBranch: configModule.DEFAULT_PAGES_PRODUCTION_BRANCH,
      sessionSnapshotTtlDays: configModule.DEFAULT_SESSION_SNAPSHOT_TTL_DAYS,
    });
    expect(parsed.prefix).toBe(configModule.derivePrefix('example.com'));
  });

  it('honors explicit resource prefix, R2 location, and Pages branch overrides', () => {
    const parsed = configModule.parseInfraConfig(
      makeConfig({
        resourcePrefix: 'fork',
        r2Location: 'WEUR',
        pagesProductionBranch: 'release/2026-06',
        sessionSnapshotTtlDays: '14',
      }),
      'prod'
    );

    expect(parsed).toMatchObject({
      prefix: 'fork',
      r2Location: 'WEUR',
      pagesProductionBranch: 'release/2026-06',
      sessionSnapshotTtlDays: 14,
    });
  });

  it.each([
    ['cloudflareAccountId', undefined, 'Missing required Pulumi config'],
    ['cloudflareAccountId', '   ', 'must not be empty'],
    ['cloudflareZoneId', undefined, 'Missing required Pulumi config'],
    ['cloudflareZoneId', '   ', 'must not be empty'],
    ['baseDomain', undefined, 'Missing required Pulumi config'],
    ['baseDomain', '   ', 'must not be empty'],
    ['resourcePrefix', '   ', 'must not be empty'],
    ['pagesProductionBranch', '   ', 'must not be empty'],
    ['sessionSnapshotTtlDays', '0', 'must be a positive integer'],
    ['sessionSnapshotTtlDays', '1.5', 'must be a positive integer'],
  ])('fails fast for invalid %s config', (key, value, expectedMessage) => {
    const beforeResourceCount = getRegisteredResources().length;

    expect(() => configModule.parseInfraConfig(makeConfig({ [key]: value }), 'staging')).toThrow(
      expectedMessage
    );
    expect(getRegisteredResources()).toHaveLength(beforeResourceCount);
  });

  it('rejects unsupported R2 locations before resources are registered', () => {
    const beforeResourceCount = getRegisteredResources().length;

    expect(() =>
      configModule.parseInfraConfig(makeConfig({ r2Location: 'MARS' }), 'staging')
    ).toThrow('Pulumi config "r2Location" must be one of: WNAM, ENAM, WEUR, EEUR, APAC, OC');
    expect(getRegisteredResources()).toHaveLength(beforeResourceCount);
  });

  it('accepts every Cloudflare-supported R2 location', () => {
    for (const location of configModule.SUPPORTED_R2_LOCATIONS) {
      expect(
        configModule.parseInfraConfig(makeConfig({ r2Location: location }), 'staging').r2Location
      ).toBe(location);
    }
  });
});
