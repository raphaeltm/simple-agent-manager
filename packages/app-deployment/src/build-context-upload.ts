import type { BuildContextDescriptor, BuildContextOwner } from './build-context-state';
import { buildContextKey } from './build-context-state';
import type { AppDeploymentEnv as Env } from './env';
import type { ObjectUrlSigner } from './object-url-signer';

/** Only job-derived keys are signed. Metadata binds the uploaded object to the
 * digest declared before upload; builders must still hash bytes after download.
 * The URL comes from the worker's object URL signer (`signer`): a presigned URL through the shared
 * R2 S3 client (`WHEN_REQUIRED` checksums), or a box upload URL that also verifies the digest. */
export async function createBuildContextUpload(
  owner: BuildContextOwner,
  descriptor: BuildContextDescriptor,
  expiresIn: number,
  signer: ObjectUrlSigner
) {
  const r2Key = buildContextKey(owner);
  const uploadUrl = await signer.putUrl(r2Key, {
    expiresIn,
    contentLength: descriptor.sizeBytes,
    contentType: 'application/zstd',
    metadata: { sha256: descriptor.sha256 },
    sha256: descriptor.sha256,
    owner: { userId: owner.requestedBy, projectId: owner.projectId, workspaceId: owner.workspaceId },
  });
  return { r2Key, uploadUrl, expiresIn };
}
export async function verifyBuildContextObject(
  env: Env,
  owner: BuildContextOwner,
  descriptor: BuildContextDescriptor
) {
  const head = await env.R2.head(buildContextKey(owner));
  return (
    head !== null &&
    head.size === descriptor.sizeBytes &&
    head.customMetadata?.sha256 === descriptor.sha256
  );
}

export async function createBuildContextDownload(
  r2Key: string,
  expiresIn: number,
  signer: ObjectUrlSigner
) {
  return signer.getUrl(r2Key, { expiresIn });
}
