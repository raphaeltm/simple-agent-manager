/**
 * Admin settings for box object uploads. Only the self-host entry registers them
 * (`installBoxObjectUrls`), so a Cloudflare admin never sees them.
 */
import {
  type AdminSettingDefinition,
  type AdminSettingName,
  integerDefinition,
} from '../../services/admin-setting-definitions';

/**
 * Concurrent uploads the box accepts before answering 503 (`gate.ts` has the memory arithmetic:
 * about 85 MB of celld RSS per in-flight upload over a ~150 MB base).
 */
export const DEFAULT_BOX_OBJECT_MAX_CONCURRENT_UPLOADS = 4;

/**
 * Seconds one upload holds its slot at most. It frees the slot of a handler that died without
 * releasing it. An upload that runs longer is not cut; the box may then admit one upload over the
 * limit until it ends. 1800 s covers 1 GiB at 0.6 MB/s.
 */
export const DEFAULT_BOX_OBJECT_UPLOAD_LEASE_SECONDS = 1800;

/** These names exist only in the self-host build, so they are not in the shared name union. */
export const BOX_OBJECT_MAX_CONCURRENT_UPLOADS =
  'boxObjects.maxConcurrentUploads' as AdminSettingName;
export const BOX_OBJECT_UPLOAD_LEASE_SECONDS = 'boxObjects.uploadLeaseSeconds' as AdminSettingName;

export const BOX_OBJECT_SETTINGS: readonly AdminSettingDefinition[] = [
  integerDefinition(
    BOX_OBJECT_MAX_CONCURRENT_UPLOADS,
    DEFAULT_BOX_OBJECT_MAX_CONCURRENT_UPLOADS,
    'Operations',
    'Uploads (attachments, build contexts, image artifacts) the box streams at once. Each costs about 85 MB of memory while it runs; further uploads get 503 with Retry-After.',
    { min: 1, max: 64 }
  ),
  integerDefinition(
    BOX_OBJECT_UPLOAD_LEASE_SECONDS,
    DEFAULT_BOX_OBJECT_UPLOAD_LEASE_SECONDS,
    'Operations',
    'Seconds one upload counts against the concurrent-upload limit at most, so an upload whose handler died frees its slot.',
    { min: 60, max: 86_400 }
  ),
];
