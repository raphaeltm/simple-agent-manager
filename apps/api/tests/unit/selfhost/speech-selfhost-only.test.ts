/**
 * The self-host speech backend (src/selfhost/speech/) must not reach the Cloudflare bundle, while
 * the seam it plugs into (services/speech-backend.ts) must. The whole `src/selfhost/` prefix is
 * already guarded for the Worker entry (reverse-tunnel-placement.test.ts); this pins the speech
 * pair, with a positive control so an empty walk cannot pass as "all clear".
 */
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  API_SRC,
  collectImportGraph,
  selfhostOnlyFindings,
} from '../../helpers/selfhost-only-modules';

describe('self-host speech backend placement', () => {
  it('the Worker entry reaches the speech seam but no self-host speech module', () => {
    const graph = collectImportGraph(resolve(API_SRC, 'index.ts'));
    expect(graph.files).toContain('apps/api/src/services/speech-backend.ts');
    expect(graph.files.filter((file) => file.startsWith('apps/api/src/selfhost/speech/'))).toEqual(
      []
    );
  });

  it('positive control: the speech module is flagged as self-host-only when walked', () => {
    const graph = collectImportGraph(resolve(API_SRC, 'selfhost/speech/index.ts'));
    expect(selfhostOnlyFindings(graph)).toEqual(
      expect.arrayContaining([
        'apps/api/src/selfhost/speech/index.ts',
        'apps/api/src/selfhost/speech/endpoints.ts',
        'apps/api/src/selfhost/speech/settings.ts',
      ])
    );
    expect(graph.files).toContain('apps/api/src/services/speech-backend.ts');
  });
});
