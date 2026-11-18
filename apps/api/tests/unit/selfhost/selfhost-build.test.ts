/**
 * The celld entry applies `withSelfHostBuild` (scripts/selfhost/celld-project.ts). It must install
 * the L20 D1 analytics sink and its `analytics.d1.*` settings, or a box loses product analytics
 * and their retention bound. Enters through the real build function, not the sink's own installer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { withSelfHostBuild } from '../../../src/selfhost/build';
import {
  findAdminSetting,
  resetInstalledAdminSettingDefinitionsForTests,
} from '../../../src/services/admin-settings-registry';
import {
  activeLocalAnalyticsSink,
  resetLocalAnalyticsSinkExtensionForTests,
} from '../../../src/services/analytics-sink';
import { resolvePlatformCapabilities } from '../../../src/services/platform-capabilities';

const shared = { fetch: vi.fn(), scheduled: vi.fn() };
const boxEnv = { ANALYTICS_SINK: 'd1', OBSERVABILITY_DATABASE: {} } as unknown as Env;

afterEach(() => {
  resetLocalAnalyticsSinkExtensionForTests();
  resetInstalledAdminSettingDefinitionsForTests();
});

describe('withSelfHostBuild', () => {
  it('installs the D1 analytics sink and its retention settings', () => {
    // Control: nothing is installed before the build runs, so a box would have no analytics.
    expect(activeLocalAnalyticsSink(boxEnv)).toBeUndefined();
    expect(findAdminSetting('analytics.d1.retentionDays')).toBeUndefined();

    withSelfHostBuild(shared);

    expect(activeLocalAnalyticsSink(boxEnv)?.table).toBe('analytics_events');
    expect(resolvePlatformCapabilities(boxEnv).analyticsQuery).toBe(true);
    expect(findAdminSetting('analytics.d1.retentionDays')).toBeDefined();
    expect(findAdminSetting('analytics.d1.maxRows')).toBeDefined();
    // The branch's pre-L20 names are gone from every registry.
    expect(findAdminSetting('operations.analyticsD1RetentionDays')).toBeUndefined();
    expect(findAdminSetting('operations.analyticsD1MaxRows')).toBeUndefined();
  });

  it('leaves the sink inactive on an installation that does not switch it on', () => {
    withSelfHostBuild(shared);
    expect(activeLocalAnalyticsSink({ OBSERVABILITY_DATABASE: {} } as unknown as Env)).toBe(
      undefined
    );
  });
});
