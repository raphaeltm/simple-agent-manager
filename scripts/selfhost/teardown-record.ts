/** Durable teardown bookkeeping; a failed save never authorizes a later destructive step. */
import { addResource, readRecord } from '../../deploy/selfhost/created-resources.mjs';
import { replacePrivateFile } from './secret-files';
import type { RecordRef } from './teardown-model';

export function completeRemoval(file: string, refs: RecordRef[]): void {
  if (!refs.length) return;
  for (const ref of refs) {
    if (
      !readRecord(file).resources.some(
        (r) => r.cloud === ref.cloud && r.kind === ref.kind && r.name === ref.name
      )
    )
      addResource(file, {
        ...ref,
        action: 'created',
        createdBy: ref.createdBy ?? 'discovered-by-teardown',
      });
  }
  const record = readRecord(file);
  const removedAt = new Date().toISOString();
  for (const ref of refs) {
    const entry = record.resources.find(
      (r) => r.cloud === ref.cloud && r.kind === ref.kind && r.name === ref.name
    );
    if (!entry) throw new Error('Removal receipt disappeared');
    entry.removedAt = removedAt;
  }
  if (refs.length) replacePrivateFile(file, `${JSON.stringify(record, null, 2)}\n`);
}

export function updateRemovalProof(
  file: string,
  kind: string,
  name: string,
  attributes: Record<string, string>
): void {
  const record = readRecord(file);
  const entry = record.resources.find(
    (r) => r.cloud === 'box' && r.kind === kind && r.name === name
  );
  if (!entry || entry.action !== 'created' || entry.removedAt)
    throw new Error('No active resource creation receipt for removal');
  entry.attributes = { ...entry.attributes, ...attributes };
  replacePrivateFile(file, `${JSON.stringify(record, null, 2)}\n`);
}
