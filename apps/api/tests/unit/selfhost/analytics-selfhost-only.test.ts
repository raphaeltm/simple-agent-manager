/**
 * The self-host D1 analytics sink (src/selfhost/analytics/) and its migration list must not reach
 * the Cloudflare bundle, while the seam it plugs into (services/analytics-sink.ts) must. Positive
 * control included so an empty walk cannot pass as "all clear".
 */
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  API_SRC,
  collectImportGraph,
  selfhostOnlyFindings,
} from '../../helpers/selfhost-only-modules';

describe('self-host analytics sink placement', () => {
  // Walking the full Worker graph can exceed Vitest's default under shared CI load.
  it('the Worker entry reaches the analytics seam but no self-host analytics module', () => {
    const graph = collectImportGraph(resolve(API_SRC, 'index.ts'));
    expect(graph.files).toContain('apps/api/src/services/analytics-sink.ts');
    expect(
      graph.files.filter(
        (file) =>
          file.startsWith('apps/api/src/selfhost/analytics/') ||
          file === 'apps/api/src/selfhost/observability-migrations.ts'
      )
    ).toEqual([]);
  }, 30_000);

  it('positive control: the analytics module is flagged as self-host-only when walked', () => {
    const graph = collectImportGraph(resolve(API_SRC, 'selfhost/analytics/index.ts'));
    expect(selfhostOnlyFindings(graph)).toEqual(
      expect.arrayContaining([
        'apps/api/src/selfhost/analytics/index.ts',
        'apps/api/src/selfhost/analytics/d1-sink.ts',
        'apps/api/src/selfhost/analytics/settings.ts',
      ])
    );
    expect(graph.files).toContain('apps/api/src/services/analytics-sink.ts');
  });
});
