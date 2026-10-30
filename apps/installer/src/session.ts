import { BootstrapCleanup } from './cleanup';
import { cloudflare, CloudflareError, revoke } from './cloudflare';
import { installerShell } from './maintenance-brand.generated';
import { challenge, escapeHtml, json, randomSecret } from './security';
import {
  authorityLimits,
  type AuthorizedSession,
  hasBootstrapAuthority,
  SessionInstallation,
} from './session-installation';
import type { Account, CleanupJournal, Env, Session } from './types';

export class InstallerSession {
  private queue: Promise<unknown> = Promise.resolve();
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private readonly cleanup: BootstrapCleanup;
  private readonly installation: SessionInstallation;
  constructor(
    private ctx: DurableObjectState,
    private env: Env
  ) {
    this.cleanup = new BootstrapCleanup(ctx);
    this.installation = new SessionInstallation(ctx, env, this.cleanup);
  }
  async alarm(): Promise<void> {
    await this.serialize(() => this.clear());
  }
  private limits() {
    return authorityLimits(this.env);
  }
  private receipt(): string {
    return this.ctx.id.toString();
  }
  private async clear(): Promise<boolean> {
    const session = await this.ctx.storage.get<Session>('session');
    const journal = session
      ? await this.cleanup.journal(session)
      : await this.ctx.storage.get<CleanupJournal>('cleanupJournal');
    if (session?.token && session.tokenExpires && session.tokenExpires <= Date.now()) {
      // Expired authority cannot delete child principals. Retain only non-secret
      // ownership evidence for a fresh same-account grant; never retain its secrets.
      await this.ctx.storage.delete('session');
      if (journal?.authorityTransferred) await this.ctx.storage.delete('cleanupJournal');
      await this.ctx.storage.deleteAlarm();
      return false;
    }
    try {
      if (journal && session?.token)
        await this.cleanup.reconcile(
          journal,
          session.token,
          AbortSignal.timeout(this.limits().reserve)
        );
      else if (journal) {
        await this.ctx.storage.delete('session');
        return false;
      }
    } catch (error) {
      return this.failedCleanup(error, session);
    }
    const revoked = session?.token ? await revoke(session.token) : true;
    await this.ctx.storage.delete('session');
    await this.ctx.storage.deleteAlarm();
    return revoked;
  }
  private async failedCleanup(error: unknown, session?: Session): Promise<boolean> {
    if (
      (error instanceof CloudflareError && error.status === 401) ||
      (session?.tokenExpires && session.tokenExpires <= Date.now())
    ) {
      await this.ctx.storage.delete('session');
      await this.ctx.storage.deleteAlarm();
      return false;
    }
    // Retry while authority still exists, then wipe it at real expiry even if
    // provider cleanup keeps failing. Do not claim that revocation succeeded.
    if (session?.tokenExpires)
      await this.ctx.storage.setAlarm(Math.min(session.tokenExpires, Date.now() + 5000));
    throw error;
  }
  async fetch(request: Request): Promise<Response> {
    // Serialize callback consumption and provisioning, including across upstream awaits.
    return this.serialize(async () => {
      try {
        return await this.handle(request);
      } catch {
        const cleanup = await this.ctx.storage.get<CleanupJournal>('cleanupJournal');
        return json(
          {
            ...(cleanup
              ? { cleanupReceipt: this.receipt(), cleanupAccountId: cleanup.accountId }
              : {}),
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
    if (
      ['/start', '/callback'].includes(path) &&
      (!this.env.OAUTH_CLIENT_ID || !this.env.OAUTH_CLIENT_SECRET)
    )
      return json({ error: 'OAuth is not configured' }, 503);
    const session = await this.ctx.storage.get<Session>('session');
    if (path === '/cleanup-with-grant') return this.cleanupWithGrant(request, session);
    if (path === '/start') return this.start(session);
    if (!session || session.expires <= Date.now()) return this.expired(session);
    switch (path) {
      case '/callback':
        return this.callback(request, session);
      case '/finish':
        return json({ ok: true, revoked: await this.clear() });
      case '/handoff':
        return this.handoff(session);
    }
    if (!hasBootstrapAuthority(session))
      return json({ error: 'Sign in with Cloudflare to continue.' }, 401);
    switch (path) {
      case '/reconcile-cleanup':
        return this.reconcileCleanup(request, session);
      case '/status':
        return this.status(session);
      case '/zones':
        return this.zones(request, session);
      case '/preview':
        return this.installation.preview(request, session);
      case '/install':
        return this.installation.install(request, session);
      default:
        return json({ error: 'Not found' }, 404);
    }
  }
  private async expired(session?: Session): Promise<Response> {
    if (session) await this.clear();
    const cleanup = await this.ctx.storage.get<CleanupJournal>('cleanupJournal');
    return json(
      {
        error: 'Your installer session expired. Sign in again.',
        ...(cleanup ? { cleanupReceipt: this.receipt(), cleanupAccountId: cleanup.accountId } : {}),
      },
      401
    );
  }
  private async cleanupWithGrant(request: Request, session?: Session): Promise<Response> {
    const { accountId, token } = (await request.json()) as { accountId: string; token: string };
    const journal = await this.ctx.storage.get<CleanupJournal>('cleanupJournal');
    if (!journal) return json({ ok: true });
    if (
      accountId !== journal.accountId ||
      typeof token !== 'string' ||
      !token ||
      token.length > 8192
    )
      return json({ error: 'Cleanup account mismatch' }, 403);
    const transferred = await this.cleanup.reconcile(
      journal,
      token,
      AbortSignal.timeout(this.limits().reserve)
    );
    await this.ctx.storage.delete('session');
    await this.ctx.storage.deleteAlarm();
    const previousGrantRevoked =
      session?.token && session.token !== token ? await revoke(session.token) : undefined;
    return json({ ok: true, authorityPreserved: transferred, previousGrantRevoked });
  }
  private async start(session?: Session): Promise<Response> {
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
      client_id: this.env.OAUTH_CLIENT_ID || '',
      redirect_uri: `${this.env.APP_ORIGIN}/oauth/callback`,
      response_type: 'code',
      scope: this.env.OAUTH_SCOPES,
      state: session.state,
      code_challenge: await challenge(session.verifier),
      code_challenge_method: 'S256',
    }).toString();
    return json({ url: url.toString() });
  }
  private async callback(request: Request, session: Session): Promise<Response> {
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
        client_id: this.env.OAUTH_CLIENT_ID || '',
        client_secret: this.env.OAUTH_CLIENT_SECRET || '',
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return json({ error: 'Cloudflare authorization failed. Start again.' }, 401);
    const token = (await response.json()) as { access_token?: string; expires_in?: number };
    if (
      !token.access_token ||
      typeof token.expires_in !== 'number' ||
      !Number.isFinite(token.expires_in) ||
      token.expires_in <= 0
    )
      return json({ error: 'Cloudflare returned an invalid token response' }, 502);
    const limits = this.limits();
    const tokenExpires = Date.now() + token.expires_in * 1000;
    const expires = Math.min(session.expires, tokenExpires - limits.reserve);
    if (expires - Date.now() < limits.minimum) {
      await revoke(token.access_token);
      return json({ error: 'Cloudflare authorization expires too soon. Start again.' }, 401);
    }
    session.token = token.access_token;
    session.tokenExpires = tokenExpires;
    session.expires = expires;
    await this.ctx.storage.put('session', session);
    await this.ctx.storage.setAlarm(session.expires);
    return json({ ok: true });
  }
  private async handoff(session: Session): Promise<Response> {
    if (session.job?.status !== 'ready' || !session.job.url)
      return json({ error: 'Create the service first' }, 409);
    // Retain only the bounded claim until expiry, so a lost response can be retried.
    const { url, key } = session.job;
    const revoked = session.token ? await revoke(session.token) : true;
    delete session.token;
    delete session.tokenExpires;
    delete session.credentials;
    await this.ctx.storage.put('session', session);
    return new Response(
      installerShell.before +
        `<script type="module" src="/handoff.js"></script><p class="eyebrow">HANDOFF READY</p><h1>Continue in your account</h1><p>Our temporary Cloudflare credential has been deleted. This claim page remains available until its short session expires. ${revoked ? 'Cloudflare accepted the token revocation request.' : 'Revocation could not be confirmed. Revoke the installer authorization in your Cloudflare profile.'}</p><form id="maintenance-claim-form" method="post" action="${escapeHtml(url)}/claim"><input type="hidden" name="key" value="${escapeHtml(key)}"><input type="hidden" id="maintenance-recovery" name="recovery"><label for="maintenance-recovery-display">Save your recovery credential</label><input id="maintenance-recovery-display" readonly><p id="maintenance-handoff-status">Your browser creates this credential locally. Save it in your password manager before continuing. It is never sent to our hosted service.</p><label class="check"><input type="checkbox" id="maintenance-recovery-saved" required><span>I saved my recovery credential.</span></label><button class="sam-btn sam-btn--primary" id="maintenance-claim-submit" disabled>Open my installation service</button></form><p>Save the recovery credential shown by your service. It lets you return independently of this temporary installer session.</p>` +
        installerShell.after,
      {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; form-action ${url}; frame-ancestors 'none'; base-uri 'none'`,
        },
      }
    );
  }
  private async reconcileCleanup(request: Request, session: AuthorizedSession): Promise<Response> {
    const { receipt, accountId } = (await request.json()) as {
      receipt: string;
      accountId: string;
    };
    if (
      typeof receipt !== 'string' ||
      !/^[a-f0-9]{64}$/.test(receipt) ||
      receipt === this.receipt() ||
      !/^[a-f0-9]{32}$/.test(accountId)
    )
      return json({ error: 'Invalid cleanup receipt' }, 400);
    const accounts = await cloudflare<Account[]>(session.token, '/accounts?per_page=50');
    if (!accounts.some((account) => account.id === accountId))
      return json({ error: 'Choose the original authorized account' }, 403);
    const stub = this.env.SESSIONS.get(this.env.SESSIONS.idFromString(receipt));
    // Do not let cross-session cleanup hold this actor's queue indefinitely:
    // simultaneous A→B and B→A requests can otherwise form a circular wait.
    const timeoutMs = Math.min(
      this.limits().reserve,
      session.expires - Date.now(),
      session.tokenExpires - Date.now()
    );
    if (timeoutMs <= 0) return json({ error: 'Sign in again to finish cleanup.' }, 401);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        stub.fetch(
          new Request('https://session/cleanup-with-grant', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountId, token: session.token }),
            signal: controller.signal,
          })
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('Cleanup transport deadline exceeded'));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  private async status(session: AuthorizedSession): Promise<Response> {
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
      currentCleanupReceipt: this.receipt(),
      plan: session.plan,
      ...((session.credentialTokenIds?.length || session.job?.authorityTransferStarted) &&
      !session.job?.authorityTransferred
        ? { cleanupReceipt: this.receipt(), cleanupAccountId: session.job?.accountId }
        : {}),
    });
  }
  private async zones(request: Request, session: AuthorizedSession): Promise<Response> {
    const { accountId } = (await request.json()) as { accountId: string };
    if (!session.accounts?.some((account) => account.id === accountId))
      return json({ error: 'Choose an authorized account' }, 400);
    const zones = await cloudflare<NonNullable<Session['zones']>>(
      session.token,
      `/zones?account.id=${accountId}&status=active&per_page=50`
    );
    session.zones = zones.filter((zone) => zone.account.id === accountId);
    await this.ctx.storage.put('session', session);
    return json({ zones: session.zones.map(({ id, name }) => ({ id, name })) });
  }
}
