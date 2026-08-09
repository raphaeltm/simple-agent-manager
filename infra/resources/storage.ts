import * as cloudflare from '@pulumi/cloudflare';
import {
  accountId,
  diagnosticIncidentPrefix,
  diagnosticIncidentTtlDays,
  prefix,
  r2Location,
  sessionSnapshotTtlDays,
  stack,
  tempUploadTtlDays,
  ttsTtlDays,
} from './config';

export const SESSION_SNAPSHOT_LIFECYCLE_RULE_ID = 'expire-session-snapshots';
export const SESSION_SNAPSHOT_R2_PREFIX = 'session-snapshots/';
export const TEMP_UPLOAD_LIFECYCLE_RULE_ID = 'expire-temp-uploads';
export const TEMP_UPLOAD_R2_PREFIX = 'temp-uploads/';
export const TTS_LIFECYCLE_RULE_ID = 'expire-tts-cache';
export const TTS_R2_PREFIX = 'tts/';
export const DIAGNOSTIC_INCIDENT_LIFECYCLE_RULE_ID = 'expire-diagnostic-incidents';
export const DIAGNOSTIC_INCIDENT_R2_PREFIX = `${diagnosticIncidentPrefix}/`;
const SECONDS_PER_DAY = 24 * 60 * 60;

export const r2Bucket = new cloudflare.R2Bucket(`${prefix}-r2`, {
  accountId,
  name: `${prefix}-${stack}-assets`,
  location: r2Location,
});

export const r2BucketLifecycle = new cloudflare.R2BucketLifecycle(
  `${prefix}-r2-lifecycle`,
  {
    accountId,
    bucketName: r2Bucket.name,
    rules: [
      {
        id: SESSION_SNAPSHOT_LIFECYCLE_RULE_ID,
        conditions: { prefix: SESSION_SNAPSHOT_R2_PREFIX },
        enabled: true,
        deleteObjectsTransition: {
          condition: {
            maxAge: sessionSnapshotTtlDays * SECONDS_PER_DAY,
            type: 'Age',
          },
        },
      },
      {
        id: DIAGNOSTIC_INCIDENT_LIFECYCLE_RULE_ID,
        conditions: { prefix: DIAGNOSTIC_INCIDENT_R2_PREFIX },
        enabled: true,
        deleteObjectsTransition: {
          condition: {
            maxAge: diagnosticIncidentTtlDays * SECONDS_PER_DAY,
            type: 'Age',
          },
        },
      },
      {
        id: TEMP_UPLOAD_LIFECYCLE_RULE_ID,
        conditions: { prefix: TEMP_UPLOAD_R2_PREFIX },
        enabled: true,
        deleteObjectsTransition: {
          condition: {
            maxAge: tempUploadTtlDays * SECONDS_PER_DAY,
            type: 'Age',
          },
        },
      },
      {
        id: TTS_LIFECYCLE_RULE_ID,
        conditions: { prefix: TTS_R2_PREFIX },
        enabled: true,
        deleteObjectsTransition: {
          condition: {
            maxAge: ttsTtlDays * SECONDS_PER_DAY,
            type: 'Age',
          },
        },
      },
    ],
  },
  { dependsOn: r2Bucket }
);

export const r2BucketName = r2Bucket.name;
