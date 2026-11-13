/**
 * One bounded page of a self-hosted rotation over library files: each object under `library/`
 * in env.R2 carries its data key wrapped by the library KEK in custom metadata
 * (file-encryption.ts). `migrate` re-wraps the data key under the current KEK and writes the
 * object back with the same body and HTTP metadata; `verify` proves every wrapped key opens
 * under the current KEK. The file body is never decrypted.
 *
 * The write is conditional on the etag read (`onlyIf.etagMatches`), so a file a user replaces
 * meanwhile (replaceFile writes the same key) is never overwritten with the old body; a lost
 * race is counted and the verify pass checks the new object. An object whose key opens under
 * neither KEK is reported and left alone.
 *
 * Work bound: a page lists at most `limit` objects and stops at `deadlineMs` after at least
 * one object; each object costs a head, and when re-wrapped a get and a put of its body.
 */
import type { FileEncryptionMetadata } from '@simple-agent-manager/shared';

import {
  fileKeyUnwrapsWith,
  metadataToR2CustomMetadata,
  r2CustomMetadataToMetadata,
  rewrapFileKey,
} from '../../services/file-encryption';
import { MAX_REPORTED_ROWS, type PassInput, type PassMode, type PassResult } from './d1-pass';
import type { RoleKeys } from './keys';

export const LIBRARY_LOCATION = 'library_files';
const LIBRARY_PREFIX = 'library/';

function encryptionMetadata(
  custom: Record<string, string> | undefined
): FileEncryptionMetadata | null {
  try {
    return custom ? r2CustomMetadataToMetadata(custom) : null;
  } catch {
    return null;
  }
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
    if (!head || !metadata) {
      result.nextCursor = listed.key;
      continue;
    }
    result.scanned += 1;
    const issue = { location: LIBRARY_LOCATION, id: listed.key, column: 'x-enc-wrapped-dek' };
    if (await fileKeyUnwrapsWith(metadata, keys.current)) {
      result.current += 1;
    } else if (!keys.previous || !(await fileKeyUnwrapsWith(metadata, keys.previous))) {
      result.unreadable += 1;
      if (result.unreadableRows.length < MAX_REPORTED_ROWS) result.unreadableRows.push(issue);
    } else if (mode === 'verify') {
      result.previous += 1;
      if (result.previousRows.length < MAX_REPORTED_ROWS) result.previousRows.push(issue);
    } else {
      const rewrapped = await rewrapFileKey(metadata, keys.previous, keys.current);
      const object = await bucket.get(listed.key, { onlyIf: { etagMatches: head.etag } });
      const body = object && 'body' in object ? await object.arrayBuffer() : null;
      const written = body
        ? await bucket.put(listed.key, body, {
            onlyIf: { etagMatches: head.etag },
            httpMetadata: head.httpMetadata,
            customMetadata: { ...head.customMetadata, ...metadataToR2CustomMetadata(rewrapped) },
          })
        : null;
      if (written) {
        result.migrated += 1;
      } else {
        result.previous += 1;
        if (result.previousRows.length < MAX_REPORTED_ROWS) result.previousRows.push(issue);
      }
    }
    result.nextCursor = listed.key;
  }
  result.done = !listing.truncated;
  return result;
}
