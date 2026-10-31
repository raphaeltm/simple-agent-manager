import type { GitHubInstallation } from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { type Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { AppError, errors } from '../middleware/error';
import { resolveAdminSettingDetailsMany } from '../services/admin-settings';
import { IoTimeoutError, withDeadline } from '../services/fetch-timeout';
import { getAuthenticatedGitHubUser, getUserAccessibleInstallations } from '../services/github-app';
import { normalizeAccountType } from '../services/github-installation-accounts';
import { getExternalInstallationId } from '../services/github-installation-ids';
import { getGitHubUserAccessToken } from '../services/github-user-access-token';
import { filterVisibleInstallations, syncUserInstallations } from './github-installation-sync';
export function registerGitHubInstallationsRoute(githubRoutes: Hono<{ Bindings: Env }>) {
  githubRoutes.get('/installations', requireAuth(), requireApproved(), async (c) => {
    const userId = getUserId(c);
    const db = drizzle(c.env.DATABASE, { schema });

    const limits = await resolveAdminSettingDetailsMany(c.env, [
      'performance.githubRequestTimeoutMs',
      'performance.githubInstallationsDeadlineMs',
    ]);
    const [requestLimit, deadlineLimit] = limits;
    if (!requestLimit || !deadlineLimit) throw errors.internal('GitHub timeouts are unavailable');
    const requestTimeoutMs = Number(requestLimit.value);
    const deadlineMs = Number(deadlineLimit.value);
    return withDeadline(
      async (callerSignal) => {
        const io = { callerSignal, timeoutMs: requestTimeoutMs };
        // Sync: discover installations the user can access but doesn't have a DB record for
        const accessToken = await getGitHubUserAccessToken(c, userId);
        log.info('github.installations_sync.token_status', {
          userId,
          tokenPresent: Boolean(accessToken),
        });
        const verified = accessToken
          ? await Promise.all([
              getAuthenticatedGitHubUser(accessToken, { flow: 'sync', userId, ...io }),
              getUserAccessibleInstallations(accessToken, { flow: 'sync', userId, ...io }),
            ])
          : null;
        if (accessToken && verified) {
          await syncUserInstallations(db, userId, accessToken, verified, io);
        }

        const installations = await db
          .select()
          .from(schema.githubInstallations)
          .where(eq(schema.githubInstallations.userId, userId));
        const visibleInstallations =
          accessToken && verified
            ? await filterVisibleInstallations(db, userId, installations, verified)
            : installations.filter(
                (inst) => normalizeAccountType(inst.accountType) === 'organization'
              );

        const response: GitHubInstallation[] = visibleInstallations.map((inst) => ({
          id: inst.id,
          userId: inst.userId,
          installationId: getExternalInstallationId(inst),
          accountType: inst.accountType as 'personal' | 'organization',
          accountName: inst.accountName,
          createdAt: inst.createdAt,
          updatedAt: inst.updatedAt,
        }));

        return c.json(response);
      },
      deadlineMs,
      c.req.raw.signal
    ).catch((error: unknown) => {
      if (error instanceof IoTimeoutError)
        throw new AppError(
          504,
          'GITHUB_TIMEOUT',
          'GitHub installation discovery timed out. Try again.'
        );
      throw error;
    });
  });
}
