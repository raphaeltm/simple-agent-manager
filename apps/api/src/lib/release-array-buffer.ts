/**
 * Release an exclusively owned backing store without waiting for GC. Workerd and
 * our Node toolchain implement ES2024 transfer; the API package targets older TS libs.
 */
export function releaseArrayBuffer(buffer: ArrayBufferLike): void {
  if (!('transfer' in buffer) || typeof buffer.transfer !== 'function') {
    throw new Error('Runtime does not support ArrayBuffer.transfer');
  }
  buffer.transfer(0);
}
