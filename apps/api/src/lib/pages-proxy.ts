export type PagesProxyTarget =
  | { type: 'none' }
  | { type: 'assets' }
  | { type: 'proxy'; hostname: string }
  | { type: 'missing-config'; message: string }
  | { type: 'redirect'; hostname: string };

export interface PagesProxyConfig {
  baseDomain: string;
  appPagesProjectName?: string;
  wwwPagesProjectName?: string;
  /**
   * True when the Worker has an `ASSETS` binding holding the apps/web build. Only
   * self-hosted (celld) deployments bind it (`scripts/selfhost/celld-config.ts`); Cloudflare
   * deployments serve the web UI from Pages and never set it.
   */
  hasWebAssets?: boolean;
}

export function resolvePagesProxyTarget(
  hostname: string,
  config: PagesProxyConfig
): PagesProxyTarget {
  if (!config.baseDomain) {
    return { type: 'none' };
  }

  if (hostname === `app.${config.baseDomain}`) {
    if (config.hasWebAssets) {
      return { type: 'assets' };
    }
    if (!config.appPagesProjectName) {
      return { type: 'missing-config', message: 'PAGES_PROJECT_NAME is not configured' };
    }

    return { type: 'proxy', hostname: `${config.appPagesProjectName}.pages.dev` };
  }

  if (hostname === `www.${config.baseDomain}`) {
    if (!config.wwwPagesProjectName) {
      return { type: 'missing-config', message: 'WWW_PAGES_PROJECT_NAME is not configured' };
    }

    return { type: 'proxy', hostname: `${config.wwwPagesProjectName}.pages.dev` };
  }

  if (hostname === config.baseDomain) {
    return { type: 'redirect', hostname: `www.${config.baseDomain}` };
  }

  return { type: 'none' };
}
