import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('deployment release callback route ordering', () => {
  it('mounts callback-auth deploy release route before session-auth node routes', () => {
    const source = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8');

    const deployReleaseIndex = source.indexOf(
      "app.route('/api/nodes', deployReleaseCallbackRoute)"
    );
    const deploymentReleaseEventsIndex = source.indexOf(
      "app.route('/api/nodes', deploymentReleaseEventsCallbackRoute)"
    );
    const nodesIndex = source.indexOf("app.route('/api/nodes', nodesRoutes)");
    const nodeLifecycleIndex = source.indexOf("app.route('/api/nodes', nodeLifecycleRoutes)");

    expect(deployReleaseIndex).toBeGreaterThan(-1);
    expect(deploymentReleaseEventsIndex).toBeGreaterThan(-1);
    expect(nodesIndex).toBeGreaterThan(-1);
    expect(nodeLifecycleIndex).toBeGreaterThan(-1);
    expect(deployReleaseIndex).toBeLessThan(nodesIndex);
    expect(deploymentReleaseEventsIndex).toBeLessThan(nodesIndex);
    expect(nodesIndex).toBeLessThan(nodeLifecycleIndex);
  });

  it('keeps deploy callbacks out of session-auth wildcard middleware', () => {
    const source = readFileSync(join(process.cwd(), 'src/routes/nodes.ts'), 'utf8');

    expect(source).toContain("path.endsWith('/deploy-release')");
    expect(source).toContain("path.endsWith('/deploy-routes')");
    expect(source).not.toContain("path.endsWith('/deployment-release-events')");
  });
});
