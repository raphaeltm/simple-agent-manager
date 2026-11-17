/**
 * What the AI proxy package needs from the rest of the worker. The worker builds an
 * `AiProxyPorts` bound to its environment (`aiProxyPorts(env)` in
 * `apps/api/src/services/ai-proxy-ports.ts`) and passes it in; the package never imports
 * worker modules.
 */

/** A decrypted platform agent credential, as the platform-key billing mode uses it. */
export interface PlatformAgentKey {
  credentialId: string;
  credential: string;
}

export interface AiProxyPorts {
  /**
   * The enabled Claude Code platform credential, decrypted with the credential encryption key,
   * or null when none is configured.
   */
  getPlatformAnthropicKey(): Promise<PlatformAgentKey | null>;
  /** Admin setting `performance.externalReadTimeoutMs`, used for AI Gateway API reads. */
  externalReadTimeoutMs(): Promise<number>;
  /**
   * Admin setting `aiProxy.monthlyCostCeilingUsd`: the most any one user may spend on SAM-priced
   * AI calls in a UTC month, in whole USD; 0 means no ceiling. Superadmin-only. Read only where
   * SAM meters spend itself (`hasLocalAiCostMetering`), so AI Gateway installs never pay for it.
   */
  monthlyCostCeilingUsd(): Promise<number>;
}
