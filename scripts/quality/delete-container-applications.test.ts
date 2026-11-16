import { describe, expect, it } from 'vitest';

import {
  deleteContainerApplications,
  installationApplications,
} from '../deploy/delete-container-applications.mjs';

const APPS = [
  { id: 'a1', name: 'sam2-api-staging2-vmagentcontainer-staging2' },
  { id: 'a2', name: 'sam2-api-staging2-sandboxdo-staging2' },
  { id: 'b1', name: 'sam-api-staging-vmagentcontainer-staging' },
  { id: 'b2', name: 'sam-api-staging-sandboxdo-staging' },
  { id: 'c1', name: 'sam-api-prod-sandboxdo-prod' },
  { id: 'd1', name: 'sam-api-staging2-x-staging' },
];

describe('installationApplications', () => {
  it("selects only the installation's own applications", () => {
    expect(
      installationApplications(APPS, 'sam2-api-staging2', 'staging2').map((a) => a.id)
    ).toEqual(['a1', 'a2']);
    // The primary's teardown never matches staging2's or production's applications.
    expect(installationApplications(APPS, 'sam-api-staging', 'staging').map((a) => a.id)).toEqual([
      'b1',
      'b2',
    ]);
  });
});

describe('deleteContainerApplications', () => {
  function fakeApi() {
    const deleted: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if ((init.method ?? 'GET') === 'GET') return Response.json({ success: true, result: APPS });
      deleted.push(url.split('/').pop() ?? '');
      return Response.json({ success: true, result: null });
    }) as unknown as typeof fetch;
    return { deleted, fetchImpl };
  }
  const base = {
    accountId: 'acct',
    token: 't',
    apiWorker: 'sam2-api-staging2',
    stack: 'staging2',
    log: () => {},
  };

  it('deletes exactly the matching applications', async () => {
    const api = fakeApi();
    await deleteContainerApplications({ ...base, fetchImpl: api.fetchImpl });
    expect(api.deleted).toEqual(['a1', 'a2']);
  });

  it('deletes nothing on a dry run', async () => {
    const api = fakeApi();
    const names = await deleteContainerApplications({
      ...base,
      dryRun: true,
      fetchImpl: api.fetchImpl,
    });
    expect(names).toHaveLength(2);
    expect(api.deleted).toEqual([]);
  });

  it.each([
    { apiWorker: 'sam2-api-staging2/../x' },
    { stack: 'staging2 ' + 'x' },
    { apiWorker: '' },
  ])('rejects unsafe input %j', async (override) => {
    await expect(
      deleteContainerApplications({ ...base, ...override, fetchImpl: fakeApi().fetchImpl })
    ).rejects.toThrow();
  });
});
