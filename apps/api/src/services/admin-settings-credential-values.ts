import { decrypt } from './encryption';

type EncryptedRow = { ciphertext: string; iv: string };
/** Same row/key lifetime as the existing credential snapshot; pending work is never shared. */
export class DecryptedCredentialValues {
  private values = new WeakMap<EncryptedRow, Map<string, string>>();

  clear(): void {
    this.values = new WeakMap();
  }

  async read(row: EncryptedRow, key: string): Promise<string> {
    let keys = this.values.get(row);
    if (!keys) {
      keys = new Map();
      this.values.set(row, keys);
    }
    const cached = keys.get(key);
    if (cached !== undefined) return cached;
    const value = await decrypt(row.ciphertext, row.iv, key);
    // Another caller may already have recovered, or a reset may have detached this slot.
    if (this.values.get(row) === keys && !keys.has(key)) keys.set(key, value);
    return keys.get(key) ?? value;
  }
}
