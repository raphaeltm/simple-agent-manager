/**
 * Default for `operations.provisioningAttemptsPerProviderTier`. Every attempt is a provider create
 * plus about a dozen D1 and HTTP subrequests, and a live catalog can give one source hundreds of
 * offerings (every zone of every machine type). Uncapped, one step could exceed the Worker
 * subrequest limit before reaching the next provider. At 8 per tier, a three-provider order is at
 * most 24 creates in one step.
 */
export const DEFAULT_PROVISIONING_ATTEMPTS_PER_PROVIDER_TIER = 8;
