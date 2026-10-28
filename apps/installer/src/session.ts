import { cloudflare, revoke } from './cloudflare';
import { maintenanceSource } from './maintenance';
import { challenge, digest, escapeHtml, json, randomSecret } from './security';
import type { Account, Env, Session } from './types';

export class InstallerSession {
  private queue: Promise<unknown> = Promise.resolve();
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }
  constructor(
    private ctx: DurableObjectState,
    private env: Env
  ) {}
  async alarm(): Promise<void> {
    await this.serialize(() => this.clear());
  }
  private async clear(): Promise<void> {
    const session = await this.ctx.storage.get<Session>('session');
    if (session?.token) await revoke(session.token);
    await this.ctx.storage.deleteAll();
  }
  async fetch(request: Request): Promise<Response> {
    // Serialize callback consumption and provisioning, including across upstream awaits.
    return this.serialize(async () => {
      try {
        return await this.handle(request);
      } catch {
        return json(
          {
            error:
              'Cloudflare could not complete this step. Check your permissions and try again. No credentials were logged.',
          },
          502
        );
      }
    });
  }
  private async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const clientId = this.env.OAUTH_CLIENT_ID;
    const clientSecret = this.env.OAUTH_CLIENT_SECRET;
    if ((path === '/start' || path === '/callback') && (!clientId || !clientSecret))
      return json({ error: 'OAuth is not configured' }, 503);
    let session = await this.ctx.storage.get<Session>('session');
    if (path === '/start') {
      if (session) return json({ error: 'Session already exists' }, 409);
      const ttl = Number(this.env.SESSION_TTL_SECONDS);
      if (!Number.isInteger(ttl) || ttl < 60 || ttl > 3600)
        return json({ error: 'Invalid installer configuration' }, 503);
      session = {
        state: randomSecret(),
        verifier: randomSecret(),
        expires: Date.now() + ttl * 1000,
      };
      await this.ctx.storage.put('session', session);
      await this.ctx.storage.setAlarm(session.expires);
      const url = new URL('https://dash.cloudflare.com/oauth2/auth');
      url.search = new URLSearchParams({
        client_id: clientId || '',
        redirect_uri: `${this.env.APP_ORIGIN}/oauth/callback`,
        response_type: 'code',
        scope: this.env.OAUTH_SCOPES,
        state: session.state,
        code_challenge: await challenge(session.verifier),
        code_challenge_method: 'S256',
      }).toString();
      return json({ url: url.toString() });
    }
    if (!session || session.expires <= Date.now()) {
      if (session) await this.clear();
      return json({ error: 'Your installer session expired. Sign in again.' }, 401);
    }
    if (path === '/callback') {
      const { code, state } = (await request.json()) as { code: string; state: string };
      if (!state || state !== session.state || !code)
        return json({ error: 'Invalid or already used authorization callback' }, 400);
      const verifier = session.verifier;
      session.state = '';
      session.verifier = '';
      await this.ctx.storage.put('session', session); // consume before network access
      const response = await fetch('https://dash.cloudflare.com/oauth2/token', {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: `${this.env.APP_ORIGIN}/oauth/callback`,
          client_id: clientId || '',
          client_secret: clientSecret || '',
          code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok)
        return json({ error: 'Cloudflare authorization failed. Start again.' }, 401);
      const token = (await response.json()) as { access_token?: string; expires_in?: number };
      if (
        !token.access_token ||
        typeof token.expires_in !== 'number' ||
        !Number.isFinite(token.expires_in) ||
        token.expires_in <= 0
      )
        return json({ error: 'Cloudflare returned an invalid token response' }, 502);
      session.token = token.access_token;
      session.tokenExpires = Date.now() + token.expires_in * 1000;
      session.expires = Math.min(session.expires, session.tokenExpires);
      await this.ctx.storage.put('session', session);
      await this.ctx.storage.setAlarm(session.expires);
      return json({ ok: true });
    }
    if (path === '/finish') {
      const revoked = session.token ? await revoke(session.token) : true;
      await this.ctx.storage.deleteAll();
      return json({ ok: true, revoked });
    }
    if (!session.token || !session.tokenExpires || session.tokenExpires <= Date.now())
      return json({ error: 'Sign in with Cloudflare to continue.' }, 401);
    if (path === '/status') {
      if (!session.accounts) {
        // Bound the list; never silently choose an account or trust a caller-supplied ID.
        session.accounts = await cloudflare<Account[]>(session.token, '/accounts?per_page=50');
        await this.ctx.storage.put('session', session);
      }
      return json({
        accounts: session.accounts.map(({ id, name }) => ({ id, name })),
        job: session.job
          ? { name: session.job.name, status: session.job.status, url: session.job.url }
          : null,
        expires: session.expires,
      });
    }
    if (path === '/install') {
      const { accountId, confirmed } = (await request.json()) as {
        accountId: string;
        confirmed: boolean;
      };
      if (
        confirmed !== true ||
        !session.accounts?.some((a) => a.id === accountId) ||
        !/^[a-f0-9]{32}$/.test(accountId)
      )
        return json({ error: 'Choose an authorized account and confirm the installation.' }, 400);
      if (session.job && session.job.accountId !== accountId)
        return json({ error: 'This session is already bound to another account.' }, 409);
      if (!session.job) {
        session.job = {
          accountId,
          name: `sam-maintenance-${randomSecret().slice(0, 16)}`,
          key: randomSecret(),
          status: 'pending',
        };
        await this.ctx.storage.put('session', session);
      }
      const job = session.job;
      if (job.status === 'ready') return json({ ok: true });
      const prefix = `/accounts/${accountId}/workers`;
      const subdomain = await cloudflare<{ subdomain: string }>(
        session.token,
        `${prefix}/subdomain`
      );
      if (!subdomain.subdomain || !/^[a-z0-9-]+$/.test(subdomain.subdomain))
        return json(
          { error: 'Enable your account’s workers.dev subdomain in Cloudflare, then retry.' },
          400
        );
      const body = new FormData();
      body.set(
        'metadata',
        new Blob(
          [
            JSON.stringify({
              main_module: 'worker.js',
              compatibility_date: '2026-10-01',
              bindings: [
                { type: 'secret_text', name: 'OWNER_KEY_HASH', text: await digest(job.key) },
                { type: 'plain_text', name: 'INSTALLER_ORIGIN', text: this.env.APP_ORIGIN },
                { type: 'plain_text', name: 'CLAIM_EXPIRES', text: String(session.expires) },
              ],
            }),
          ],
          { type: 'application/json' }
        )
      );
      body.set(
        'worker.js',
        new Blob([maintenanceSource], { type: 'application/javascript+module' }),
        'worker.js'
      );
      await cloudflare(session.token, `${prefix}/scripts/${job.name}`, { method: 'PUT', body });
      await cloudflare(session.token, `${prefix}/scripts/${job.name}/subdomain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      job.url = `https://${job.name}.${subdomain.subdomain}.workers.dev`;
      job.status = 'ready';
      await this.ctx.storage.put('session', session);
      return json({ ok: true });
    }
    if (path === '/handoff') {
      if (session.job?.status !== 'ready' || !session.job.url)
        return json({ error: 'Create the service first' }, 409);
      // One-time retrieval of the claim credential; the target only accepts it until session expiry.
      const { url, key } = session.job;
      const revoked = await revoke(session.token);
      await this.ctx.storage.deleteAll();
      return new Response(
        `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open your installation service</title><link rel="stylesheet" href="/style.css"><main><p class="eyebrow">HANDOFF READY</p><h1>Continue in your account</h1><p>Our temporary session has been deleted. ${revoked ? 'Cloudflare accepted the token revocation request.' : 'Revocation could not be confirmed. Revoke the installer authorization in your Cloudflare profile.'}</p><form method="post" action="${escapeHtml(url)}/claim"><input type="hidden" name="key" value="${escapeHtml(key)}"><button>Open my installation service</button></form><p>The prototype owner session expires shortly. Keep the Worker name from the previous screen if you want to delete it in Cloudflare.</p></main></html>`,
        {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': `default-src 'none'; style-src 'self'; form-action ${url}; frame-ancestors 'none'; base-uri 'none'`,
          },
        }
      );
    }
    return json({ error: 'Not found' }, 404);
  }
}
