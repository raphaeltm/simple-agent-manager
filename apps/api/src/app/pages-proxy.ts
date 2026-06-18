import type { ApiApp } from './types';

export function registerPagesProxy(app: ApiApp): void {
  // Proxy non-API subdomains to their respective Cloudflare Pages deployments.
  // The Worker wildcard route *.{domain}/* intercepts ALL subdomains, so we must
  // proxy app.* and www.* requests to Pages before any other middleware runs.
  // The apex domain is redirected to www.* for the marketing site.
  app.use('*', async (c, next) => {
    const hostname = new URL(c.req.url).hostname;
    const baseDomain = c.env?.BASE_DOMAIN || '';
    if (!baseDomain) { await next(); return; }

    if (hostname === `app.${baseDomain}`) {
      const pagesUrl = new URL(c.req.url);
      pagesUrl.hostname = `${c.env.PAGES_PROJECT_NAME || 'sam-web-prod'}.pages.dev`;
      return fetch(new Request(pagesUrl.toString(), c.req.raw));
    }

    if (hostname === `www.${baseDomain}`) {
      const pagesUrl = new URL(c.req.url);
      pagesUrl.hostname = `${c.env.WWW_PAGES_PROJECT_NAME || 'sam-www'}.pages.dev`;
      return fetch(new Request(pagesUrl.toString(), c.req.raw));
    }

    if (hostname === baseDomain) {
      const wwwUrl = new URL(c.req.url);
      wwwUrl.hostname = `www.${baseDomain}`;
      return c.redirect(wwwUrl.toString(), 301);
    }

    await next();
  });
}
