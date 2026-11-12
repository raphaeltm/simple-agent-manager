/** Worker implementation of the app-deployment `DeploymentSecretCipher`. */
import type { DeploymentSecretCipher } from '../app-deployment';
import { decrypt, encrypt } from '../services/encryption';

/** Binds AES-GCM encryption to one key, so callers keep choosing which key applies. */
export function createDeploymentSecretCipher(keyBase64: string): DeploymentSecretCipher {
  return {
    encrypt: (plaintext) => encrypt(plaintext, keyBase64),
    decrypt: (ciphertext, iv) => decrypt(ciphertext, iv, keyBase64),
  };
}
