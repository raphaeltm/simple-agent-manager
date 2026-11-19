// Canonical implementation lives in the app-deployment package.
// The upload keeps its original `(env, …)` signature here and binds the worker's shared R2 S3
// client (`WHEN_REQUIRED`, so the VM need not send a checksum header), which also serves compose
// artifacts, attachments and session snapshots, and works against an operator store.
import {
  createBuildContextDownload as createDownload,
  createBuildContextUpload as createUpload,
} from '@simple-agent-manager/app-deployment';

import type { Env } from '../env';
import { getR2PresignTarget } from './r2-s3-client';

export { verifyBuildContextObject } from '@simple-agent-manager/app-deployment';

type BuildContextUploadArgs = Parameters<typeof createUpload>;

// Async so a missing R2 credential rejects the returned promise instead of throwing.
export async function createBuildContextUpload(
  env: Env,
  owner: BuildContextUploadArgs[0],
  descriptor: BuildContextUploadArgs[1],
  expiresIn: BuildContextUploadArgs[2]
): ReturnType<typeof createUpload> {
  return createUpload(owner, descriptor, expiresIn, getR2PresignTarget(env, 'WHEN_REQUIRED'));
}

export async function createBuildContextDownload(env: Env, r2Key: string, expiresIn: number) {
  return createDownload(r2Key, expiresIn, getR2PresignTarget(env, 'WHEN_REQUIRED'));
}
