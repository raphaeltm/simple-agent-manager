import { cloudflare, CloudflareError } from './cloudflare';
import { digest } from './security';
import type { CleanupJournal, Session } from './types';

/** Only trusted session code supplies ownership evidence or a fresh grant. */
export class BootstrapCleanup {
  constructor(private ctx: DurableObjectState) {}
  async journal(session: Session): Promise<CleanupJournal | undefined> {
    if (!session.job) return this.ctx.storage.get<CleanupJournal>('cleanupJournal');
    const previous = await this.ctx.storage.get<CleanupJournal>('cleanupJournal');
    const tokenIds = [
      ...new Set([...(session.credentialTokenIds ?? []), ...(session.credentials?.tokenIds ?? [])]),
    ];
    if (
      !tokenIds.length &&
      !session.job.authorityTransferStarted &&
      !previous?.authorityTransferStarted
    ) {
      await this.ctx.storage.delete('cleanupJournal');
      return undefined;
    }
    const journal: CleanupJournal = {
      accountId: session.job.accountId,
      installationId: session.job.name,
      bootstrapIdentity: await digest(session.job.key),
      tokenIds,
      authorityTransferStarted:
        !!session.job.authorityTransferStarted || !!previous?.authorityTransferStarted,
      authorityTransferred: !!session.job.authorityTransferred || !!previous?.authorityTransferred,
    };
    await this.ctx.storage.put('cleanupJournal', journal);
    return journal;
  }
  async reconcile(journal: CleanupJournal, token: string, signal?: AbortSignal): Promise<boolean> {
    if (journal.authorityTransferStarted && !journal.authorityTransferred) {
      try {
        const settings = await cloudflare<{ bindings: { name: string; text?: string }[] }>(
          token,
          `/accounts/${journal.accountId}/workers/scripts/${journal.installationId}/settings`,
          { signal }
        );
        if (
          !settings.bindings.some(
            (binding) =>
              binding.name === 'BOOTSTRAP_IDENTITY' && binding.text === journal.bootstrapIdentity
          )
        )
          throw new Error('Bootstrap identity mismatch');
        journal.authorityTransferred = true;
        await this.ctx.storage.put('cleanupJournal', journal);
      } catch (error) {
        if (!(error instanceof CloudflareError) || error.status !== 404) throw error;
      }
    }
    if (!journal.authorityTransferred) {
      for (const id of [...journal.tokenIds]) {
        try {
          await cloudflare(token, `/accounts/${journal.accountId}/tokens/${id}`, {
            method: 'DELETE',
            signal,
          });
        } catch (error) {
          if (!(error instanceof CloudflareError) || error.status !== 404) throw error;
        }
        journal.tokenIds = journal.tokenIds.filter((value) => value !== id);
        await this.ctx.storage.put('cleanupJournal', journal);
        const session = await this.ctx.storage.get<Session>('session');
        if (session) {
          session.credentialTokenIds = journal.tokenIds;
          if (session.credentials) session.credentials.tokenIds = journal.tokenIds;
          await this.ctx.storage.put('session', session);
        }
      }
    }
    await this.ctx.storage.delete('cleanupJournal');
    return journal.authorityTransferred;
  }
}
