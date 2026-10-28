import { BootstrapCleanup } from './cleanup';
import { cloudflare, CloudflareError, revoke } from './cloudflare';
import { createInstallationCredentials } from './credentials';
import { previewInstallation } from './installation-plan';
import { provision } from './provision';
import { challenge, escapeHtml, json, randomSecret } from './security';
import type { Account, CleanupJournal, Env, Session } from './types';

export class InstallerSession {
  private queue: Promise<unknown> = Promise.resolve();
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private readonly cleanup: BootstrapCleanup;
  constructor(
    private ctx: DurableObjectState,
    private env: Env
  ) {
    this.cleanup = new BootstrapCleanup(ctx);
  }
  async alarm(): Promise<void> {
    await this.serialize(() => this.clear());
  }
  private limits() {
    const positive = (value: string | undefined, fallback: number) => {
      const n = value === undefined ? fallback : Number(value);
      if (!Number.isInteger(n) || n < 30 || n > 3600)
        throw new Error('Invalid authority time budget');
      return n * 1000;
    };
    return {
      reserve: positive(this.env.OAUTH_CLEANUP_RESERVE_SECONDS, 180),
      minimum: positive(this.env.MIN_PROVISION_SECONDS, 120),
      work: positive(this.env.PROVISION_TIMEOUT_SECONDS, 240),
    };
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
    const revoked = session?.token ? await revoke(session.token) : true;
    await this.ctx.storage.delete('session');
    await this.ctx.storage.deleteAlarm();
    return revoked;
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
    const clientId = this.env.OAUTH_CLIENT_ID;
    const clientSecret = this.env.OAUTH_CLIENT_SECRET;
    if ((path === '/start' || path === '/callback') && (!clientId || !clientSecret))
      return json({ error: 'OAuth is not configured' }, 503);
    let session = await this.ctx.storage.get<Session>('session');
    if (path === '/cleanup-with-grant') {
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
      const cleanup = await this.ctx.storage.get<CleanupJournal>('cleanupJournal');
      return json(
        {
          error: 'Your installer session expired. Sign in again.',
          ...(cleanup
            ? { cleanupReceipt: this.receipt(), cleanupAccountId: cleanup.accountId }
            : {}),
        },
        401
      );
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
    if (path === '/finish') {
      // Delete unused child principals before revoking bootstrap authority.
      const revoked = await this.clear();
      return json({ ok: true, revoked });
    }
    if (path === '/handoff') {
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
        `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open your installation service</title><link rel="stylesheet" href="/style.css"><script type="module" src="/handoff.js"></script><main><p class="eyebrow">HANDOFF READY</p><h1>Continue in your account</h1><p>Our temporary Cloudflare credential has been deleted. This claim page remains available until its short session expires. ${revoked ? 'Cloudflare accepted the token revocation request.' : 'Revocation could not be confirmed. Revoke the installer authorization in your Cloudflare profile.'}</p><form id="maintenance-claim-form" method="post" action="${escapeHtml(url)}/claim"><input type="hidden" name="key" value="${escapeHtml(key)}"><input type="hidden" id="maintenance-recovery" name="recovery"><label for="maintenance-recovery-display">Save your recovery credential</label><input id="maintenance-recovery-display" readonly><p id="maintenance-handoff-status">Your browser creates this credential locally. Save it in your password manager before continuing. It is never sent to our hosted service.</p><label class="check"><input type="checkbox" id="maintenance-recovery-saved" required><span>I saved my recovery credential.</span></label><button id="maintenance-claim-submit" disabled>Open my installation service</button></form><p>Save the recovery credential shown by your service. It lets you return independently of this temporary installer session.</p></main></html>`,
        {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self'; form-action ${url}; frame-ancestors 'none'; base-uri 'none'`,
          },
        }
      );
    }
    if (!session.token || !session.tokenExpires || session.tokenExpires <= Date.now())
      return json({ error: 'Sign in with Cloudflare to continue.' }, 401);
    if (path === '/reconcile-cleanup') {
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
        currentCleanupReceipt: this.receipt(),
        plan: session.plan,
        ...((session.credentialTokenIds?.length || session.job?.authorityTransferStarted) &&
        !session.job?.authorityTransferred
          ? { cleanupReceipt: this.receipt(), cleanupAccountId: session.job?.accountId }
          : {}),
      });
    }
    if (path === '/zones') {
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
    if (path === '/preview') {
      if (session.job)
        return json(
          {
            error:
              'This session is already bound to its approved installation. Start a new session to change it.',
          },
          409
        );
      const input = (await request.json()) as Record<string, unknown>;
      if (
        !this.env.INSTALL_SOURCE_COMMIT ||
        !session.accounts?.some((account) => account.id === input.accountId) ||
        !session.zones?.some(
          (zone) => zone.id === input.zoneId && zone.account.id === input.accountId
        )
      )
        return json({ error: 'Select an authorized account and zone first' }, 400);
      const plan = await previewInstallation(session.token, {
        ...input,
        sourceCommit: this.env.INSTALL_SOURCE_COMMIT,
      });
      session.plan = plan;
      await this.ctx.storage.put('session', session);
      return json({ plan });
    }
    if (path === '/install') {
      if (session.plan && !this.env.INSTALL_SOURCE_COMMIT)
        return json(
          { error: 'Full installation is disabled; disconnect to clean up this session.' },
          503
        );
      const { accountId, confirmed, fingerprint } = (await request.json()) as {
        accountId: string;
        confirmed: boolean;
        fingerprint?: string;
      };
      if (
        confirmed !== true ||
        !session.accounts?.some((a) => a.id === accountId) ||
        !/^[a-f0-9]{32}$/.test(accountId)
      )
        return json({ error: 'Choose an authorized account and confirm the installation.' }, 400);
      if (session.job && session.job.accountId !== accountId)
        return json({ error: 'This session is already bound to another account.' }, 409);
      if (this.env.INSTALL_SOURCE_COMMIT) {
        if (
          !session.plan ||
          session.plan.accountId !== accountId ||
          session.plan.fingerprint !== fingerprint ||
          session.plan.conflicts.length
        )
          return json(
            { error: 'Preview and approve an installation without DNS conflicts first.' },
            409
          );
        const fresh = await previewInstallation(session.token, session.plan);
        if (fresh.fingerprint !== fingerprint || fresh.conflicts.length)
          return json({ error: 'The installation plan changed. Review it again.' }, 409);
        if (session.job && session.job.fingerprint !== session.plan.fingerprint)
          return json({ error: 'Installation approval does not match this job' }, 409);
      }
      if (!session.job) {
        session.job = {
          accountId,
          name: `sam-maintenance-${randomSecret().slice(0, 16)}`,
          key: randomSecret(),
          status: 'pending',
          fingerprint: session.plan?.fingerprint,
        };
        await this.ctx.storage.put('session', session);
      }
      const job = session.job;
      if (job.status === 'ready') return json({ ok: true });
      const limits = this.limits();
      const deadline = Math.min(
        session.expires,
        session.tokenExpires - limits.reserve,
        Date.now() + limits.work
      );
      if (deadline - Date.now() < limits.minimum)
        return json(
          {
            error:
              'Not enough Cloudflare authorization time remains. Disconnect to clean up, then sign in again.',
          },
          409
        );
      const workSignal = AbortSignal.timeout(deadline - Date.now());

      if (session.plan && !session.credentials) {
        session.credentials = await createInstallationCredentials(
          session.token,
          session.plan,
          job.name,
          {
            initialTokenIds: session.credentialTokenIds,
            signal: workSignal,
            cleanupTimeoutMs: limits.reserve,
            authorityExpiresAt: session.tokenExpires,
            journal: async (tokenIds) => {
              session.credentialTokenIds = tokenIds;
              await this.ctx.storage.put('session', session);
              await this.cleanup.journal(session);
            },
          }
        );
        await this.ctx.storage.put('session', session);
      }
      job.authorityTransferStarted = !!session.credentials;
      await this.ctx.storage.put('session', session);
      await this.cleanup.journal(session);
      const url = await provision(
        session.token,
        accountId,
        job.name,
        job.key,
        this.env.APP_ORIGIN,
        session.expires,
        session.plan && session.credentials
          ? { config: session.plan, credentials: session.credentials }
          : undefined,
        workSignal
      );
      if (!url)
        return json(
          { error: 'Enable your account’s workers.dev subdomain in Cloudflare, then retry.' },
          400
        );
      job.authorityTransferred = !!session.credentials;
      await this.cleanup.journal(session);
      job.url = url;
      job.status = 'ready';
      await this.ctx.storage.put('session', session);
      return json({ ok: true });
    }
    return json({ error: 'Not found' }, 404);
  }
}
