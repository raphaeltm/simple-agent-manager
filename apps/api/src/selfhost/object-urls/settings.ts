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
 * Seconds a slot stays held without renewal. The route renews it while bytes keep arriving, so a
 * slow upload keeps its slot; a handler that died without releasing frees it within this time.
 */
export const DEFAULT_BOX_OBJECT_UPLOAD_LEASE_SECONDS = 300;

/**
 * Of those, how many one uploader (a workspace, else a user) may hold at once, so one uploader
 * cannot take every slot from everyone else.
 */
export const DEFAULT_BOX_OBJECT_MAX_UPLOADS_PER_UPLOADER = 2;

/**
 * Seconds an upload may go without receiving a byte before the box drops it (408) and frees its
 * slot. A slow but moving upload is never cut.
 */
export const DEFAULT_BOX_OBJECT_UPLOAD_IDLE_SECONDS = 60;

/**
 * Seconds an upload over the limit waits for a slot before the box answers 503. Clients (browser
 * attachment uploads, the VM agent's publisher) start several uploads at once and treat a 503 as
 * final, so a short queue turns "over the limit" into "a little later" instead of a failed upload.
 * 0 refuses at once.
 */
export const DEFAULT_BOX_OBJECT_UPLOAD_ADMISSION_WAIT_SECONDS = 30;

/** These names exist only in the self-host build, so they are not in the shared name union. */
export const BOX_OBJECT_MAX_CONCURRENT_UPLOADS =
  'boxObjects.maxConcurrentUploads' as AdminSettingName;
export const BOX_OBJECT_UPLOAD_LEASE_SECONDS = 'boxObjects.uploadLeaseSeconds' as AdminSettingName;
export const BOX_OBJECT_MAX_UPLOADS_PER_UPLOADER =
  'boxObjects.maxUploadsPerUploader' as AdminSettingName;
export const BOX_OBJECT_UPLOAD_IDLE_SECONDS = 'boxObjects.uploadIdleSeconds' as AdminSettingName;
export const BOX_OBJECT_UPLOAD_ADMISSION_WAIT_SECONDS =
  'boxObjects.uploadAdmissionWaitSeconds' as AdminSettingName;

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
    'Seconds an upload slot stays held without progress. Renewed while bytes arrive; frees the slot of an upload whose handler died.',
    { min: 60, max: 86_400 }
  ),
  integerDefinition(
    BOX_OBJECT_MAX_UPLOADS_PER_UPLOADER,
    DEFAULT_BOX_OBJECT_MAX_UPLOADS_PER_UPLOADER,
    'Operations',
    'Of the concurrent uploads, how many one uploader (a workspace, else a user) may hold at once.',
    { min: 1, max: 64 }
  ),
  integerDefinition(
    BOX_OBJECT_UPLOAD_IDLE_SECONDS,
    DEFAULT_BOX_OBJECT_UPLOAD_IDLE_SECONDS,
    'Operations',
    'Seconds an upload may receive no bytes before the box drops it and frees its slot.',
    { min: 5, max: 3_600 }
  ),
  integerDefinition(
    BOX_OBJECT_UPLOAD_ADMISSION_WAIT_SECONDS,
    DEFAULT_BOX_OBJECT_UPLOAD_ADMISSION_WAIT_SECONDS,
    'Operations',
    'Seconds an upload over the concurrent-upload limit waits for a free slot before the box answers 503. 0 refuses at once.',
    { min: 0, max: 600 }
  ),
];
