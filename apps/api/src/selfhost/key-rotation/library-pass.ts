/**
 * One bounded page of a self-hosted rotation over library files: each object under `library/`
 * in env.R2 carries its data key wrapped by the library KEK in custom metadata
 * (file-encryption.ts). `migrate` re-wraps the data key under the current KEK and writes the
 * object back with the same body and HTTP metadata; `verify` proves every wrapped key opens
 * under the current KEK AND that the body opens with that data key (a body paired with another
 * file's key, or altered, is reported unreadable). The body is decrypted only to check it, never
 * written decrypted.
 *
 * Writes are safe against a user replacing a file meanwhile only if the bucket honours
 * `onlyIf.etagMatches` on get and put, so a migrate page checks that first and refuses to write
 * when it does not hold (library-conditional.ts). Before writing, the body read is also checked
 * against the data key being re-wrapped. A lost race is counted under the old key and the next
 * round looks at the new object. An object whose key opens under neither KEK is reported and
 * left alone.
 *
 * Work bound: a page lists at most `limit` objects and stops at `deadlineMs` after at least one
 * object. Each object costs a head plus a get of its body (verify, and migrate when re-wrapped)
 * and one AES-GCM pass over it; a re-wrap adds a put. Bodies are at most LIBRARY_UPLOAD_MAX_BYTES
 * (50 MB default), the same ceiling a download decrypts in one piece.
 */
import type { FileEncryptionMetadata } from '@simple-agent-manager/shared';

import {
  fileBodyOpensWith,
  fileKeyUnwrapsWith,
  metadataToR2CustomMetadata,
  r2CustomMetadataToMetadata,
  rewrapFileKey,
} from '../../services/file-encryption';
import { MAX_REPORTED_ROWS, type PassInput, type PassMode, type PassResult } from './d1-pass';
import type { RoleKeys } from './keys';
import { conditionalWriteProblem } from './library-conditional';

export const LIBRARY_LOCATION = 'library_files';
const LIBRARY_PREFIX = 'library/';

type Issue = PassResult['previousRows'][number];

function encryptionMetadata(
  custom: Record<string, string> | undefined
): FileEncryptionMetadata | null {
  try {
    return custom ? r2CustomMetadataToMetadata(custom) : null;
  } catch {
    return null;
  }
}

function report(result: PassResult, kind: 'previous' | 'unreadable', issue: Issue): void {
  result[kind] += 1;
  const rows = kind === 'previous' ? result.previousRows : result.unreadableRows;
  if (rows.length < MAX_REPORTED_ROWS) rows.push(issue);
}

/** The object's body when it still has `etag`, else null (changed or gone since the head). */
async function bodyAt(bucket: R2Bucket, key: string, etag: string): Promise<ArrayBuffer | null> {
  const object = await bucket.get(key, { onlyIf: { etagMatches: etag } });
  return object && 'body' in object ? await object.arrayBuffer() : null;
}

/** The KEK this object's data key opens under, or null when neither does. */
async function wrappingKey(metadata: FileEncryptionMetadata, keys: RoleKeys) {
  if (await fileKeyUnwrapsWith(metadata, keys.current)) return keys.current;
  if (keys.previous && (await fileKeyUnwrapsWith(metadata, keys.previous))) return keys.previous;
  return null;
}

/**
 * Classify (and in migrate mode re-wrap) one listed object. The body is checked against the data
 * key before anything is counted readable or written, so a body paired with another file's key
 * (or altered) is reported unreadable and left alone, in the baseline verify as well.
 */
async function passObject(
  bucket: R2Bucket,
  keys: RoleKeys,
  mode: PassMode,
  head: R2Object,
  metadata: FileEncryptionMetadata,
  result: PassResult,
  writesChecked: () => Promise<void>
): Promise<void> {
  const issue = { location: LIBRARY_LOCATION, id: head.key, column: 'x-enc-wrapped-dek' };
  const kek = await wrappingKey(metadata, keys);
  if (!kek) return report(result, 'unreadable', issue);
  const underCurrent = kek === keys.current;
  // Already moved: a migrate page does not re-read bodies it will not write.
  if (underCurrent && mode === 'migrate') {
    result.current += 1;
    return;
  }
  if (!underCurrent && mode === 'migrate') await writesChecked();
  const body = await bodyAt(bucket, head.key, head.etag);
  // Changed since the head: the next round looks at the new object.
  if (!body) return report(result, 'previous', issue);
  if (!(await fileBodyOpensWith(body, metadata, kek))) {
    return report(result, 'unreadable', { ...issue, column: 'body' });
  }
  if (underCurrent) {
    result.current += 1;
    return;
  }
  if (mode === 'verify') return report(result, 'previous', issue);
  const rewrapped = await rewrapFileKey(metadata, kek, keys.current);
  const written = await bucket.put(head.key, body, {
    onlyIf: { etagMatches: head.etag },
    httpMetadata: head.httpMetadata,
    customMetadata: { ...head.customMetadata, ...metadataToR2CustomMetadata(rewrapped) },
  });
  if (written) result.migrated += 1;
  else report(result, 'previous', issue);
}

export async function runLibraryPass(
  bucket: R2Bucket,
  keys: RoleKeys,
  mode: PassMode,
  input: PassInput
): Promise<PassResult> {
  const now = input.now ?? Date.now;
  const result: PassResult = {
    location: LIBRARY_LOCATION,
    mode,
    nextCursor: input.cursor,
    done: false,
    scanned: 0,
    current: 0,
    migrated: 0,
    previous: 0,
    unreadable: 0,
    previousRows: [],
    unreadableRows: [],
  };
  // Once per page, before the first write: fail closed when preconditions are not honoured.
  let checked: Promise<void> | null = null;
  const writesChecked = () =>
    (checked ??= conditionalWriteProblem(bucket).then((problem) => {
      if (problem) {
        throw new Error(
          `library files: the object store does not honour conditional writes (${problem}); refusing to re-wrap file keys`
        );
      }
    }));
  const listing = await bucket.list({
    prefix: LIBRARY_PREFIX,
    limit: input.limit,
    ...(input.cursor ? { startAfter: input.cursor } : {}),
  });
  let processed = 0;
  for (const listed of listing.objects) {
    if (processed > 0 && now() > input.deadlineMs) return result;
    processed += 1;
    const head = await bucket.head(listed.key);
    const metadata = encryptionMetadata(head?.customMetadata);
    // Not an encrypted library object (or gone since the listing): nothing to rotate.
    if (head && metadata) {
      result.scanned += 1;
      await passObject(bucket, keys, mode, head, metadata, result, writesChecked);
    }
    result.nextCursor = listed.key;
  }
  result.done = !listing.truncated;
  return result;
}
