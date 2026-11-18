import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { resolveAdminSetting } from '../../../src/services/admin-settings';
import { DEPLOYMENT_PUBLISH_SETTINGS } from '../../../src/services/admin-settings-deployment-publish-definitions';
import { DEFAULT_DEPLOY_PUBLISH_JOB_DEADLINE_MARGIN_MS } from '../../../src/services/deployment-publish-job-defaults';
import { getDeploymentPublishJobSettings } from '../../../src/services/deployment-publish-job-settings';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

// The combined Go/Worker CI job runs this explicitly; ordinary Worker tests do
// not depend on a locally installed Go toolchain.
it.skipIf(process.env.SAM_PUBLISH_TIMEOUT_CONTRACT !== '1')(
  'resolves API and VM defaults and preserves VM timeout plus admission/callback margin',
  async () => {
    const { sqlite, env } = createAdminSettingsEnv();
    try {
      const settings = await getDeploymentPublishJobSettings({
        resolveSetting: (name) => resolveAdminSetting(env, name),
      });
      expect(() =>
        execFileSync(
          'go',
          [
            'test',
            '-p',
            '2',
            './internal/config',
            '-run',
            '^TestPublishDeadlineDefaultContract$',
            '-count=1',
          ],
          {
            cwd: fileURLToPath(new URL('../../../../../packages/vm-agent/', import.meta.url)),
            env: {
              ...process.env,
              SAM_TEST_API_PUBLISH_DEADLINE_MS: String(settings.deadlineMs),
              SAM_TEST_API_PUBLISH_MARGIN_MS: String(DEFAULT_DEPLOY_PUBLISH_JOB_DEADLINE_MARGIN_MS),
              SAM_TEST_API_PUBLISH_STALL_MS: String(settings.stallMs),
              SAM_TEST_API_PUBLISH_STALL_MIN_MS: String(
                DEPLOYMENT_PUBLISH_SETTINGS.find(
                  (setting) => setting.name === 'deployments.publishJobStallMs'
                )!.range!.min
              ),
            },
            timeout: 120_000,
            maxBuffer: 64 * 1024,
          }
        )
      ).not.toThrow();
    } finally {
      sqlite.close();
    }
  },
  130_000
);
