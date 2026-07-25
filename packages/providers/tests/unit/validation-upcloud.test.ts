import { describe, expect, it } from 'vitest';

import {
  validateUpCloudAccountResponse,
  validateUpCloudServerResponse,
  validateUpCloudStorageResponse,
  validateUpCloudStoragesResponse,
} from '../../src/validation-upcloud';

describe('UpCloud response validation', () => {
  it.each([
    ['account wrapper', () => validateUpCloudAccountResponse({}, 'account')],
    [
      'server UUID',
      () =>
        validateUpCloudServerResponse({ server: { state: 'started', zone: 'de-fra1' } }, 'server'),
    ],
    [
      'storage size',
      () =>
        validateUpCloudStorageResponse(
          { storage: { uuid: 'v', title: 'data', size: 'not-a-number' } },
          'storage'
        ),
    ],
    [
      'storage collection wrapper',
      () => validateUpCloudStoragesResponse({ storages: { storage: {} } }, 'storages'),
    ],
  ])('rejects malformed %s responses', (_name, validate) => {
    expect(validate).toThrow();
  });

  it('normalizes nested UpCloud wrappers without unsafe casts', () => {
    expect(
      validateUpCloudStorageResponse(
        {
          storage: {
            uuid: 'v-1',
            title: 'data',
            size: '20',
            state: 'online',
            zone: 'de-fra1',
            tier: 'maxiops',
            labels: { label: [{ key: 'managed-by', value: 'sam' }] },
            servers: { server: ['srv-1'] },
          },
        },
        'storage'
      )
    ).toMatchObject({
      uuid: 'v-1',
      size: 20,
      labels: [{ key: 'managed-by', value: 'sam' }],
      servers: ['srv-1'],
    });
  });
});
