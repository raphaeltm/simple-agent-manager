import { eq, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Context } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { expectJsonRecord, optionalJsonRecord } from '../lib/runtime-validation';
import { getWebhookSecret } from '../lib/secrets';
import { ulid } from '../lib/ulid';
import { AppError, errors } from '../middleware/error';
import { verifyWebhookSignature } from '../services/github-app';
import {
  getCanonicalAccountInput,
  personalInstallationOwnerMatches,
  tombstoneCanonicalInstallationAccount,
  upsertCanonicalInstallationAccount,
} from '../services/github-installation-accounts';
import { getStoredInstallationId } from '../services/github-installation-ids';
import { handleGitHubEventForTriggers } from '../services/github-trigger-handler';

type GitHubContext = Context<{ Bindings: Env }>;

/** POST /api/github/webhook - Handle GitHub App webhooks */
export async function handleGitHubWebhook(c: GitHubContext): Promise<Response> {
  const signature = c.req.header('x-hub-signature-256');
  const event = c.req.header('x-github-event');
  const payload = await c.req.text();

  if (!signature) {
    throw errors.unauthorized('Missing webhook signature');
  }

  const webhookSecret = getWebhookSecret(c.env);
  const isValid = await verifyWebhookSignature(payload, signature, webhookSecret);
  if (!isValid) {
    throw errors.unauthorized('Invalid webhook signature');
  }

  let data: Record<string, unknown>;
  try {
    data = expectJsonRecord(JSON.parse(payload), 'github.webhook');
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw errors.badRequest('Invalid JSON in webhook payload');
  }

  const db = drizzle(c.env.DATABASE, { schema });
  const now = new Date().toISOString();

  if (event === 'installation') {
    await handleInstallationEvent(db, data, now);
  }

  if (event === 'repository') {
    await handleRepositoryEvent(db, data, now);
  }

  const deliveryId = c.req.header('x-github-delivery');
  if (event && deliveryId) {
    c.executionCtx.waitUntil(handleTriggerRouting(c, deliveryId, event, data));
  }

  return c.json({ received: true });
}

async function handleInstallationEvent(
  db: ReturnType<typeof drizzle<typeof schema>>,
  data: Record<string, unknown>,
  now: string
): Promise<void> {
  const action = data.action;
  const installation = optionalJsonRecord(data.installation, 'github.webhook.installation');
  const sender = optionalJsonRecord(data.sender, 'github.webhook.sender');

  if (action === 'created' && installation?.id != null) {
    const account = optionalJsonRecord(installation.account, 'github.webhook.installation.account');
    const canonicalAccount = getCanonicalAccountInput(
      String(installation.id),
      account?.type,
      account?.login
    );
    await upsertCanonicalInstallationAccount(db, canonicalAccount, now);

    if (sender?.id == null) return;

    const users = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.githubId, String(sender.id)))
      .limit(1);

    const foundUser = users[0];
    if (!foundUser) return;

    // Personal-installation owner guard (mirrors the OAuth/sync path in github.ts).
    // A personal installation may only be recorded under the SAM user whose GitHub
    // identity owns it. The webhook `sender` is the installer; only insert the
    // per-user row when the installation's account identity matches the sender.
    // Org installations are owned at the org level, so they are exempt.
    if (canonicalAccount.accountType === 'personal') {
      const ownerMatches = personalInstallationOwnerMatches(
        {
          id: typeof account?.id === 'number' ? account.id : null,
          login: typeof account?.login === 'string' ? account.login : null,
        },
        {
          id: typeof sender.id === 'number' ? sender.id : null,
          login: typeof sender.login === 'string' ? sender.login : null,
        }
      );
      if (!ownerMatches) {
        log.warn('github.webhook.personal_installation_owner_mismatch', {
          installationId: String(installation.id),
          senderId: String(sender.id),
          accountId: account?.id != null ? String(account.id) : null,
          accountLogin: typeof account?.login === 'string' ? account.login : null,
        });
        return;
      }
    }

    await db.insert(schema.githubInstallations).values({
      id: ulid(),
      userId: foundUser.id,
      installationId: getStoredInstallationId(foundUser.id, String(installation.id)),
      externalInstallationId: String(installation.id),
      accountType: canonicalAccount.accountType,
      accountName: canonicalAccount.accountName,
      createdAt: now,
      updatedAt: now,
    });
  } else if (action === 'deleted' && installation?.id != null) {
    const account = optionalJsonRecord(installation.account, 'github.webhook.installation.account');
    await tombstoneCanonicalInstallationAccount(
      db,
      getCanonicalAccountInput(String(installation.id), account?.type, account?.login),
      now
    );
    await db
      .delete(schema.githubInstallations)
      .where(
        or(
          eq(schema.githubInstallations.installationId, String(installation.id)),
          eq(schema.githubInstallations.externalInstallationId, String(installation.id))
        )
      );
  }
}

async function handleRepositoryEvent(
  db: ReturnType<typeof drizzle<typeof schema>>,
  data: Record<string, unknown>,
  now: string
): Promise<void> {
  const action = data.action;
  const repo = optionalJsonRecord(data.repository, 'github.webhook.repository');
  const repoId = typeof repo?.id === 'number' ? repo.id : undefined;

  if (repoId !== undefined && (action === 'renamed' || action === 'transferred')) {
    const newFullName =
      typeof repo?.full_name === 'string' ? repo.full_name.toLowerCase() : undefined;
    if (!newFullName) return;
    await db
      .update(schema.projects)
      .set({ repository: newFullName, updatedAt: now })
      .where(eq(schema.projects.githubRepoId, repoId));
  } else if (repoId !== undefined && action === 'deleted') {
    await db
      .update(schema.projects)
      .set({ status: 'detached', updatedAt: now })
      .where(eq(schema.projects.githubRepoId, repoId));
  }
}

async function handleTriggerRouting(
  c: GitHubContext,
  deliveryId: string,
  event: string,
  data: Record<string, unknown>
): Promise<void> {
  try {
    const triggerResult = await handleGitHubEventForTriggers(c.env, {
      deliveryId,
      eventType: event,
      payload: data,
    });
    if (triggerResult.matchedTriggers > 0) {
      log.info('github.webhook.triggers_matched', {
        deliveryId,
        eventType: event,
        matchedTriggers: triggerResult.matchedTriggers,
      });
    }
  } catch (err) {
    log.error('github.webhook.trigger_handler_error', {
      deliveryId,
      eventType: event,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
