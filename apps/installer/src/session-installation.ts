import type { BootstrapCleanup } from './cleanup';
import { createInstallationCredentials } from './credentials';
import { previewInstallation } from './installation-plan';
import { provision } from './provision';
import { json, randomSecret } from './security';
import type { Env, Session } from './types';

export type AuthorizedSession = Session & { token: string; tokenExpires: number };
export function hasBootstrapAuthority(session: Session): session is AuthorizedSession {
  return !!session.token && !!session.tokenExpires && session.tokenExpires > Date.now();
}
export function authorityLimits(env: Env) {
  const positive = (value: string | undefined, fallback: number) => {
    const n = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(n) || n < 30 || n > 3600)
      throw new Error('Invalid authority time budget');
    return n * 1000;
  };
  return {
    reserve: positive(env.OAUTH_CLEANUP_RESERVE_SECONDS, 180),
    minimum: positive(env.MIN_PROVISION_SECONDS, 120),
    work: positive(env.PROVISION_TIMEOUT_SECONDS, 240),
  };
}
export class SessionInstallation {
  constructor(
    private ctx: DurableObjectState,
    private env: Env,
    private cleanup: BootstrapCleanup
  ) {}
  async preview(request: Request, session: AuthorizedSession): Promise<Response> {
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
  async install(request: Request, session: AuthorizedSession): Promise<Response> {
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
    const approvalError = await this.approve(session, accountId, confirmed, fingerprint);
    if (approvalError) return approvalError;
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
    const limits = authorityLimits(this.env);
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
  private async approve(
    session: AuthorizedSession,
    accountId: string,
    confirmed: boolean,
    fingerprint?: string
  ): Promise<Response | undefined> {
    if (
      confirmed !== true ||
      !session.accounts?.some((a) => a.id === accountId) ||
      !/^[a-f0-9]{32}$/.test(accountId)
    )
      return json({ error: 'Choose an authorized account and confirm the installation.' }, 400);
    if (session.job && session.job.accountId !== accountId)
      return json({ error: 'This session is already bound to another account.' }, 409);
    if (!this.env.INSTALL_SOURCE_COMMIT) return undefined;
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

    return undefined;
  }
}
