/**
 * Feature flags for the application
 * Control feature rollout and A/B testing
 */

export interface FeatureFlags {
  /** Enable multi-terminal UI with tabs */
  multiTerminal: boolean;

  /** Enable conversation view (future feature) */
  conversationView: boolean;

  /** Enable mobile optimizations */
  mobileOptimized: boolean;

  /** Enable debug mode */
  debugMode: boolean;
}

/**
 * Get feature flags from environment variables
 */
export function getFeatureFlags(): FeatureFlags {
  return {
    multiTerminal: import.meta.env.VITE_FEATURE_MULTI_TERMINAL === 'true',
    conversationView: import.meta.env.VITE_FEATURE_CONVERSATION_VIEW === 'true',
    mobileOptimized: import.meta.env.VITE_FEATURE_MOBILE_OPTIMIZED !== 'false', // Default true
    debugMode: import.meta.env.VITE_DEBUG === 'true',
  };
}

/**
 * Check if a specific feature is enabled
 */
export function isFeatureEnabled(feature: keyof FeatureFlags): boolean {
  const flags = getFeatureFlags();
  return flags[feature];
}

/**
 * Hook to use feature flags in React components
 */
export function useFeatureFlags(): FeatureFlags {
  return getFeatureFlags();
}