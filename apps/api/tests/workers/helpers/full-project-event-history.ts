import { env } from 'cloudflare:test';
import { afterEach, beforeEach } from 'vitest';

import type { Env } from '../../../src/env';
import { invalidateAdminSettings } from '../../../src/services/admin-settings';

/** Existing receipt/history suites explicitly exercise the runtime rollback mode. */
export function useFullProjectEventHistory(): void {
  beforeEach(async () => {
    await env.DATABASE.prepare(
      'INSERT INTO platform_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    )
      .bind('events.skipUnsubscribedGitHubCi', 'false')
      .run();
    invalidateAdminSettings(env as unknown as Env);
  });
  afterEach(async () => {
    await env.DATABASE.prepare('DELETE FROM platform_settings WHERE key=?')
      .bind('events.skipUnsubscribedGitHubCi')
      .run();
    invalidateAdminSettings(env as unknown as Env);
  });
}
