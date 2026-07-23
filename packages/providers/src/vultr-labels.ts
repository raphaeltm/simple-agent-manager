import { kvTagsToLabels, labelsToKvTags } from './kv-tags';

/** Separator joining `key=value` pairs inside Vultr's single block-storage label string. */
export const VULTR_BLOCK_LABEL_SEPARATOR = ';';

/**
 * Vultr block volumes expose a single free-form `label` string (they have no
 * key/value tag array like instances). SAM encodes its labels map into that single
 * string so `getVolume`/`listVolumes` can faithfully round-trip them.
 *
 * Nothing in the control plane filters volumes by label (volumes are tracked by
 * `providerVolumeId` in D1; `listVolumes` has no callers), so this is metadata
 * fidelity for a correct `Provider` implementation, not a hard routing contract.
 */
export function encodeVultrBlockLabel(labels: Record<string, string>): string {
  return labelsToKvTags(labels).join(VULTR_BLOCK_LABEL_SEPARATOR);
}

/** Decode a Vultr block-storage `label` string back into a labels record. */
export function decodeVultrBlockLabel(label: string | null | undefined): Record<string, string> {
  if (!label) return {};
  return kvTagsToLabels(label.split(VULTR_BLOCK_LABEL_SEPARATOR));
}
