export interface DeploymentHostnames {
  api: string;
  app: string;
  wildcard: string;
  vmWildcard: string;
}

/**
 * Build every installation-level hostname from one deployment domain.
 *
 * The deployment domain may be either a zone apex (example.com) or a nested
 * namespace inside a shared zone (dev-a.example.com). Keeping this derivation
 * centralized prevents create/delete paths from drifting and orphaning DNS.
 */
export function buildDeploymentHostnames(baseDomain: string): DeploymentHostnames {
  return {
    api: `api.${baseDomain}`,
    app: `app.${baseDomain}`,
    wildcard: `*.${baseDomain}`,
    vmWildcard: `*.vm.${baseDomain}`,
  };
}
