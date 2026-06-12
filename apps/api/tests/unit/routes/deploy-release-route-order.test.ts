import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('deployment release callback route ordering', () => {
  it('mounts callback-auth deploy release route before session-auth node routes', () => {
    const source = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8');

    const deployReleaseIndex = source.indexOf("app.route('/api/nodes', deployReleaseCallbackRoute)");
    const nodesIndex = source.indexOf("app.route('/api/nodes', nodesRoutes)");

    expect(deployReleaseIndex).toBeGreaterThan(-1);
    expect(nodesIndex).toBeGreaterThan(-1);
    expect(deployReleaseIndex).toBeLessThan(nodesIndex);
  });
});
