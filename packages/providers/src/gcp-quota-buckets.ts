/**
 * Which GCP quota bucket refused a create, and which other offerings that bucket also rules out.
 *
 * A GCP quota is scoped to one metric in one region: `T2D_CPUS` in `europe-west1` says nothing
 * about T2D in `europe-west4`, E2 in `europe-west1`, or a smaller T2D type that still fits. The
 * caller's recovery action is therefore "skip what this bucket rules out and keep trying the rest
 * of this provider", not "this provider refused" (`.claude/rules/72`). Production on 2026-11-12/13
 * sent 14 tasks to Hetzner after `Quota 'T2D_CPUS' exceeded.  Limit: 24.0 in region europe-west1.`
 * while europe-west4 T2D quota and all E2 quota were unused.
 *
 * Only a message that names both a metric and a region yields a bucket. A quota that is not
 * regional (for example `CPUS_ALL_REGIONS`) returns null and the caller keeps treating the whole
 * source as refused.
 */
import { providerLocationRegion } from '@simple-agent-manager/shared';

import { classifyGcpError } from './gcp-metadata';
import type { ProviderError } from './types';

function gcpZoneRegion(zone: string): string {
  return providerLocationRegion('gcp', zone);
}

/**
 * What the exhausted metric counts, which decides what else it rules out:
 *
 *   cpus   vCPUs of one machine family (`T2D_CPUS`) or the generic regional `CPUS`. An offering
 *          of the same family needing at least as many vCPUs is ruled out; a smaller one may fit.
 *   ssd    `SSD_TOTAL_GB`: SSD-backed disk in the region. A pd-balanced boot disk at least as
 *          large is ruled out; a smaller one may fit.
 *   other  Anything else a VM consumes in the region (instances, in-use addresses). Every
 *          offering in the region needs one, so the whole region is ruled out.
 */
export type GcpQuotaResource = 'cpus' | 'ssd' | 'other';

export interface GcpQuotaBucket {
  /** The quota metric GCP named, e.g. `T2D_CPUS`. */
  metric: string;
  /** The region the quota belongs to, e.g. `europe-west1`. */
  region: string;
  resource: GcpQuotaResource;
  /**
   * For a family CPU metric, the machine series it counts (`t2d`). Null for the generic `CPUS`
   * metric, whose family coverage GCP does not state; the caller then rules out only the series
   * that was refused.
   */
  series: string | null;
}

/** "Quota 'T2D_CPUS' exceeded.  Limit: 24.0 in region europe-west1." */
const GCP_REGIONAL_QUOTA_MESSAGE =
  /quota '([A-Z0-9_]+)' exceeded\.?\s+limit:\s*[\d.]+\s+in region ([a-z0-9-]+)/i;

/**
 * The bucket a GCP `quota_exceeded` names, or null when the error is not a GCP quota refusal or
 * does not name a regional metric.
 */
export function classifyGcpQuotaBucket(err: ProviderError): GcpQuotaBucket | null {
  if (err.providerName !== 'gcp') return null;
  const category =
    err.category !== 'unknown'
      ? err.category
      : classifyGcpError(err.statusCode, err.providerCode, err.message);
  if (category !== 'quota_exceeded') return null;
  const match = GCP_REGIONAL_QUOTA_MESSAGE.exec(err.message);
  if (!match) return null;
  const metric = (match[1] as string).toUpperCase();
  const region = (match[2] as string).toLowerCase();
  if (metric === 'CPUS') return { metric, region, resource: 'cpus', series: null };
  const family = /^([A-Z][A-Z0-9]*)_CPUS$/.exec(metric);
  if (family) {
    return { metric, region, resource: 'cpus', series: (family[1] as string).toLowerCase() };
  }
  if (metric === 'SSD_TOTAL_GB') return { metric, region, resource: 'ssd', series: null };
  return { metric, region, resource: 'other', series: null };
}

/** The machine series of a GCP machine type: `t2d-standard-8` → `t2d`. */
export function gcpMachineSeries(machineType: string): string {
  return machineType.trim().toLowerCase().split('-', 1)[0] ?? '';
}

/** An offering compared against a bucket: its type, zone and size. */
export interface GcpQuotaOffering {
  machineType: string;
  zone: string;
  vcpuCount: number | null;
  diskGb: number | null;
}

/**
 * Whether `bucket`, which refused `refused`, also rules out `offering`. An offering whose size
 * is unknown is never ruled out: trying it costs one create call, while skipping it wrongly could
 * send the task to another provider when this one had room.
 */
export function gcpQuotaBucketCovers(
  bucket: GcpQuotaBucket,
  refused: GcpQuotaOffering,
  offering: GcpQuotaOffering
): boolean {
  if (gcpZoneRegion(offering.zone) !== bucket.region) return false;
  switch (bucket.resource) {
    case 'cpus': {
      const series = bucket.series ?? gcpMachineSeries(refused.machineType);
      if (gcpMachineSeries(offering.machineType) !== series) return false;
      if (offering.vcpuCount === null || refused.vcpuCount === null) return false;
      return offering.vcpuCount >= refused.vcpuCount;
    }
    case 'ssd':
      if (offering.diskGb === null || refused.diskGb === null) return false;
      return offering.diskGb >= refused.diskGb;
    case 'other':
      return true;
  }
}

/**
 * The quota bucket an offering most likely draws on, as a key for spreading a capped attempt list
 * across buckets: one exhausted bucket must not fill every slot. Family CPU quotas are the ones
 * that run out first, so the key is region plus machine series.
 */
export function gcpOfferingQuotaBucketKey(machineType: string, zone: string): string {
  return `${gcpZoneRegion(zone)}|${gcpMachineSeries(machineType)}`;
}

export function describeGcpQuotaBucket(bucket: GcpQuotaBucket): string {
  return `GCP quota ${bucket.metric} in ${bucket.region}`;
}
