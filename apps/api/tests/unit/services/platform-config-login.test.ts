import { describe, expect, it } from 'vitest';

import {
  resolveLoginOAuthConfig,
  resolvePlatformConfig,
  savePlatformIntegrationConfig,
  selectGitHubOAuthConfig,
  selectGitLabOAuthConfig,
  selectGoogleLoginOAuthConfig,
} from '../../../src/services/platform-config';
import { createEnv } from '../../helpers/platform-config-counting-fixture';

const projectLogin = (config: Awaited<ReturnType<typeof resolveLoginOAuthConfig>>) => ({
  github: selectGitHubOAuthConfig(config),
  google: selectGoogleLoginOAuthConfig(config),
  gitlab: selectGitLabOAuthConfig(config),
});

describe('focused login OAuth configuration', () => {
  it.each(['environment', 'database', 'unset'])(
    'preserves %s provider configuration',
    async (source) => {
      const { env } = createEnv(
        source === 'unset'
          ? { GITHUB_CLIENT_SECRET: '', GOOGLE_LOGIN_CLIENT_SECRET: '', GITLAB_CLIENT_SECRET: '' }
          : {}
      );
      if (source === 'database') {
        await savePlatformIntegrationConfig(env, {
          github: { clientId: 'runtime-github', clientSecret: 'runtime-github-secret' },
          google: { clientId: 'runtime-google', clientSecret: 'runtime-google-secret' },
          gitlab: {
            host: 'https://gitlab.runtime.example/',
            clientId: 'runtime-gitlab',
            clientSecret: 'runtime-gitlab-secret',
          },
        });
      }
      const focused = await resolveLoginOAuthConfig(env);
      const full = await resolvePlatformConfig(env);
      expect(projectLogin(focused)).toEqual(projectLogin(full));
      if (source === 'unset') {
        expect(projectLogin(focused)).toEqual({ github: null, google: null, gitlab: null });
      } else {
        expect(projectLogin(focused).github?.clientId).toBe(
          source === 'database' ? 'runtime-github' : 'env-gh-client'
        );
      }
    }
  );
});
