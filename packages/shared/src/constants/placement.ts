/** Canonical SAM node identifiers are ULIDs (uppercase Crockford Base32). */
export const SAM_NODE_ID_LENGTH = 26;
export const SAM_NODE_ID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Provider location identifiers are bounded, printable slug-like values. */
export const VM_LOCATION_ID_MAX_LENGTH = 64;
export const VM_LOCATION_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeVmLocationId(value: string): boolean {
  return value.length <= VM_LOCATION_ID_MAX_LENGTH && VM_LOCATION_ID_REGEX.test(value);
}
