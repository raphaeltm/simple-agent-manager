const encoder = new TextEncoder();

/** Size of `value` in UTF-8 bytes — what byte-denominated limits are measured in. */
export function utf8ByteLength(value: string): number {
  return encoder.encode(value).length;
}
