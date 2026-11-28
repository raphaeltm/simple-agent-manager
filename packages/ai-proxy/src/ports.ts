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
   * Admin setting `aiProxy.perUserMonthlyCostCeilingUsd`: the most any one user may spend on
   * platform-funded AI calls in a UTC month, in whole USD; 0 means no ceiling. Superadmin-only.
   * Read on every install (with a gateway it bounds the gateway total plus the recent estimate).
   */
  monthlyCostCeilingUsd(): Promise<number>;
  /**
   * Admin setting `aiProxy.costEstimateGatewayLagSeconds`: how far before the gateway total's
   * read time the catalog estimate keeps counting (ai-cost-estimate.ts). Gateway installs only.
   */
  costEstimateGatewayLagSeconds(): Promise<number>;
}
