/**
 * GCP quota buckets: a quota refusal names one metric in one region, and rules out only what that
 * metric counts there. Messages use GCP's exact wording, including production's
 * "Quota 'T2D_CPUS' exceeded.  Limit: 24.0 in region europe-west1." (2026-11-12/13).
 */
import { describe, expect, it } from 'vitest';

import {
  classifyGcpQuotaBucket,
  gcpOfferingQuotaBucketKey,
  gcpQuotaBucketCovers,
  type GcpQuotaOffering,
} from '../../src/gcp-quota-buckets';
import { ProviderError } from '../../src/types';

function gcpError(message: string, providerCode = 'QUOTA_EXCEEDED', statusCode?: number) {
  return new ProviderError('gcp', statusCode, message, { providerCode });
}

const offering = (
  machineType: string,
  zone: string,
  vcpuCount: number | null,
  diskGb: number | null = 160
): GcpQuotaOffering => ({ machineType, zone, vcpuCount, diskGb });

describe('classifyGcpQuotaBucket', () => {
  it('reads the metric and region from the operation error production recorded', () => {
    const err = gcpError(
      "GCP operation failed: QUOTA_EXCEEDED: Quota 'T2D_CPUS' exceeded.  Limit: 24.0 in region europe-west1."
    );
    expect(classifyGcpQuotaBucket(err)).toEqual({
      metric: 'T2D_CPUS',
      region: 'europe-west1',
      resource: 'cpus',
      series: 't2d',
    });
  });

  it('reads a synchronous 403 quota message with no provider code', () => {
    const err = gcpError(
      "Quota 'SSD_TOTAL_GB' exceeded.  Limit: 20480.0 in region us-central1.",
      undefined as never,
      403
    );
    expect(classifyGcpQuotaBucket(err)).toMatchObject({ metric: 'SSD_TOTAL_GB', resource: 'ssd' });
  });

  it.each([
    ["Quota 'CPUS' exceeded.  Limit: 8.0 in region us-central1.", 'cpus', null],
    ["Quota 'IN_USE_ADDRESSES' exceeded.  Limit: 8.0 in region us-central1.", 'other', null],
  ])('%s → %s', (message, resource, series) => {
    expect(classifyGcpQuotaBucket(gcpError(message))).toMatchObject({ resource, series });
  });

  it('returns null for a quota that names no region, for other categories and other providers', () => {
    expect(
      classifyGcpQuotaBucket(gcpError("Quota 'CPUS_ALL_REGIONS' exceeded.  Limit: 32.0 globally."))
    ).toBeNull();
    expect(
      classifyGcpQuotaBucket(
        gcpError(
          "The zone 'projects/p/zones/europe-west1-b' does not have enough resources",
          'ZONE_RESOURCE_POOL_EXHAUSTED'
        )
      )
    ).toBeNull();
    expect(
      classifyGcpQuotaBucket(
        new ProviderError(
          'hetzner',
          403,
          "Quota 'T2D_CPUS' exceeded.  Limit: 24.0 in region europe-west1.",
          {
            category: 'quota_exceeded',
          }
        )
      )
    ).toBeNull();
  });
});

describe('gcpQuotaBucketCovers', () => {
  const t2d = classifyGcpQuotaBucket(
    gcpError("Quota 'T2D_CPUS' exceeded.  Limit: 24.0 in region europe-west1.")
  )!;
  const refused = offering('t2d-standard-8', 'europe-west1-b', 8);

  it('rules out the same family in the same region needing at least as many vCPUs', () => {
    expect(
      gcpQuotaBucketCovers(t2d, refused, offering('t2d-standard-8', 'europe-west1-c', 8))
    ).toBe(true);
    expect(
      gcpQuotaBucketCovers(t2d, refused, offering('t2d-standard-16', 'europe-west1-d', 16))
    ).toBe(true);
  });

  it('leaves smaller types, other families, other regions and unknown sizes', () => {
    expect(
      gcpQuotaBucketCovers(t2d, refused, offering('t2d-standard-4', 'europe-west1-b', 4))
    ).toBe(false);
    expect(gcpQuotaBucketCovers(t2d, refused, offering('e2-standard-8', 'europe-west1-b', 8))).toBe(
      false
    );
    expect(
      gcpQuotaBucketCovers(t2d, refused, offering('t2d-standard-8', 'europe-west4-a', 8))
    ).toBe(false);
    expect(
      gcpQuotaBucketCovers(t2d, refused, offering('t2d-standard-8', 'europe-west1-c', null))
    ).toBe(false);
  });

  it('a generic CPUS quota covers only the refused family', () => {
    const cpus = classifyGcpQuotaBucket(
      gcpError("Quota 'CPUS' exceeded.  Limit: 8.0 in region us-central1.")
    )!;
    const e2 = offering('e2-standard-4', 'us-central1-a', 4);
    expect(gcpQuotaBucketCovers(cpus, e2, offering('e2-standard-4', 'us-central1-b', 4))).toBe(
      true
    );
    expect(gcpQuotaBucketCovers(cpus, e2, offering('n2d-standard-4', 'us-central1-b', 4))).toBe(
      false
    );
  });

  it('an SSD quota rules out disks at least as large; another metric rules out the region', () => {
    const ssd = classifyGcpQuotaBucket(
      gcpError("Quota 'SSD_TOTAL_GB' exceeded.  Limit: 500.0 in region us-central1.")
    )!;
    const big = offering('e2-standard-8', 'us-central1-a', 8, 160);
    expect(
      gcpQuotaBucketCovers(ssd, big, offering('n2d-standard-8', 'us-central1-b', 8, 160))
    ).toBe(true);
    expect(gcpQuotaBucketCovers(ssd, big, offering('e2-standard-4', 'us-central1-b', 4, 80))).toBe(
      false
    );
    const ips = classifyGcpQuotaBucket(
      gcpError("Quota 'IN_USE_ADDRESSES' exceeded.  Limit: 8.0 in region us-central1.")
    )!;
    expect(gcpQuotaBucketCovers(ips, big, offering('e2-medium', 'us-central1-f', 2, 50))).toBe(
      true
    );
    expect(gcpQuotaBucketCovers(ips, big, offering('e2-medium', 'us-east1-b', 2, 50))).toBe(false);
  });
});

describe('gcpOfferingQuotaBucketKey', () => {
  it('keys by region and machine series', () => {
    expect(gcpOfferingQuotaBucketKey('t2d-standard-8', 'europe-west1-b')).toBe('europe-west1|t2d');
    expect(gcpOfferingQuotaBucketKey('t2d-standard-4', 'europe-west1-c')).toBe('europe-west1|t2d');
    expect(gcpOfferingQuotaBucketKey('e2-standard-8', 'europe-west1-b')).toBe('europe-west1|e2');
  });
});
