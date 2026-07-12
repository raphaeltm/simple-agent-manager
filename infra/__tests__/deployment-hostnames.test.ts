import { describe, expect, it } from 'vitest';

import { buildDeploymentHostnames } from '../resources/deployment-hostnames';

describe('deployment hostname construction', () => {
  it('preserves the legacy apex-domain hostname layout', () => {
    expect(buildDeploymentHostnames('example.com')).toEqual({
      api: 'api.example.com',
      app: 'app.example.com',
      wildcard: '*.example.com',
      vmWildcard: '*.vm.example.com',
    });
  });

  it('qualifies every hostname under a nested deployment domain', () => {
    expect(buildDeploymentHostnames('dev-a.example.com')).toEqual({
      api: 'api.dev-a.example.com',
      app: 'app.dev-a.example.com',
      wildcard: '*.dev-a.example.com',
      vmWildcard: '*.vm.dev-a.example.com',
    });
  });

  it('keeps sibling installation hostname namespaces disjoint', () => {
    const installationA = Object.values(buildDeploymentHostnames('dev-a.example.com'));
    const installationB = Object.values(buildDeploymentHostnames('dev-b.example.com'));

    expect(installationA).not.toEqual(installationB);
    expect(installationA.filter((hostname) => installationB.includes(hostname))).toEqual([]);
  });
});
