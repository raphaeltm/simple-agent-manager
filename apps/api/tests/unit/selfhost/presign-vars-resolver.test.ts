/**
 * The self-host deploy writes the operator-store presign vars (scripts/selfhost/box-settings.ts
 * `presignVars`); the Worker reads them through main's `resolveR2PresignConfig` (L20), which
 * refuses an operator store without a signing region. Run the real producer into the real
 * consumer so a box cannot deploy vars its own Worker turns into "presigning off".
 */
import { describe, expect, it } from 'vitest';

import { presignVars } from '../../../../../scripts/selfhost/box-settings';
import { resolveR2PresignConfig } from '../../../src/services/r2-presign-config';

const credentials = {
  R2_ACCESS_KEY_ID: 'scoped-key-id',
  R2_SECRET_ACCESS_KEY: 'scoped-key-secret',
};
type PresignEnv = Parameters<typeof resolveR2PresignConfig>[0];

describe('presignVars → resolveR2PresignConfig', () => {
  it('yields an operator store the Worker accepts for a gs:// box', () => {
    const vars = presignVars(
      { CELLD_BUCKET: 'gs://my-bucket/celld/', R2_S3_ENDPOINT: 'https://storage.googleapis.com' },
      'assets'
    );
    expect(resolveR2PresignConfig({ ...vars, ...credentials } as PresignEnv)).toMatchObject({
      endpoint: 'https://storage.googleapis.com',
      bucket: 'my-bucket',
      keyPrefix: 'celld/r2/assets/',
      region: 'auto',
    });
  });

  it('passes an s3:// store region through to the Worker', () => {
    const vars = presignVars(
      {
        CELLD_BUCKET: 's3://celld-fleet',
        R2_S3_ENDPOINT: 'https://s3.example.com',
        R2_S3_REGION: 'us-east-1',
      },
      'assets'
    );
    expect(resolveR2PresignConfig({ ...vars, ...credentials } as PresignEnv)?.region).toBe(
      'us-east-1'
    );
  });

  it('control: the same vars without the region leave presigning off in the Worker', () => {
    const vars: Record<string, string> = presignVars(
      { CELLD_BUCKET: 'gs://my-bucket/celld/', R2_S3_ENDPOINT: 'https://storage.googleapis.com' },
      'assets'
    );
    delete vars.R2_S3_REGION;
    expect(resolveR2PresignConfig({ ...vars, ...credentials } as PresignEnv)).toBeNull();
  });
});
