// Scaleway encodes SAM labels as `key=value` tag strings — the generic encoding
// now lives in kv-tags.ts (shared with the Vultr provider). Re-exported under the
// original Scaleway-named symbols so existing imports keep working unchanged.
export {
  labelsToKvTags as labelsToScalewayTags,
  kvTagsToLabels as scalewayTagsToLabels,
} from './kv-tags';
