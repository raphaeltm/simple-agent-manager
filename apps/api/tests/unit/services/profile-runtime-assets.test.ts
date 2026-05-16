import { describe, expect, it } from 'vitest';

import { mergeRuntimeAssetRows } from '../../../src/services/profile-runtime-assets';

describe('mergeRuntimeAssetRows', () => {
  it('keeps project assets when no profile assets exist', () => {
    const merged = mergeRuntimeAssetRows(
      {
        envVars: [{ key: 'PROJECT_ONLY', value: 'project', isSecret: false }],
        files: [{ path: '.env', content: 'PROJECT=1', isSecret: false }],
      },
      { envVars: [], files: [] }
    );

    expect(merged.envVars).toEqual([{ key: 'PROJECT_ONLY', value: 'project', isSecret: false }]);
    expect(merged.files).toEqual([{ path: '.env', content: 'PROJECT=1', isSecret: false }]);
  });

  it('lets profile env vars and files override project assets on key/path collision', () => {
    const merged = mergeRuntimeAssetRows(
      {
        envVars: [
          { key: 'SHARED', value: 'project', isSecret: false },
          { key: 'PROJECT_ONLY', value: 'project-only', isSecret: false },
        ],
        files: [
          { path: '.env', content: 'PROJECT=1', isSecret: false },
          { path: 'shared.txt', content: 'project-file', isSecret: false },
        ],
      },
      {
        envVars: [
          { key: 'SHARED', value: 'profile', isSecret: true },
          { key: 'PROFILE_ONLY', value: 'profile-only', isSecret: false },
        ],
        files: [
          { path: 'shared.txt', content: 'profile-file', isSecret: true },
          { path: 'profile.txt', content: 'profile-only-file', isSecret: false },
        ],
      }
    );

    expect(merged.envVars).toEqual([
      { key: 'SHARED', value: 'profile', isSecret: true },
      { key: 'PROJECT_ONLY', value: 'project-only', isSecret: false },
      { key: 'PROFILE_ONLY', value: 'profile-only', isSecret: false },
    ]);
    expect(merged.files).toEqual([
      { path: '.env', content: 'PROJECT=1', isSecret: false },
      { path: 'shared.txt', content: 'profile-file', isSecret: true },
      { path: 'profile.txt', content: 'profile-only-file', isSecret: false },
    ]);
  });
});
