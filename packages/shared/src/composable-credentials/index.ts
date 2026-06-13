// Re-export with CC prefix to avoid collision with existing shared types
// (agents.ts exports CredentialKind, types/user.ts exports Credential-related types)
export type {
  CredentialKind as CCCredentialKind,
  CredentialSecret as CCCredentialSecret,
  Credential as CCCredential,
  ConsumerKind as CCConsumerKind,
  ConsumerRef as CCConsumerRef,
  Configuration as CCConfiguration,
  ConfigurationSettings as CCConfigurationSettings,
  AttachmentScope as CCAttachmentScope,
  Attachment as CCAttachment,
  PlatformDefault as CCPlatformDefault,
  CompositionSnapshot as CCCompositionSnapshot,
  ResolutionContext as CCResolutionContext,
  ResolutionSource as CCResolutionSource,
  ResolvedEnvironment as CCResolvedEnvironment,
} from './types';
export { consumerKey } from './types';
export { resolveEnvironment } from './resolver';
export type {
  EnvInjection as CCEnvInjection,
  ProviderConfig as CCProviderConfig,
  Assembler as CCAssembler,
} from './assemblers';
export { agentAssembler, computeAssembler, sanitizeModelAlias } from './assemblers';
export type {
  SourceCredentialRow as CCSourceCredentialRow,
  SourcePlatformRow as CCSourcePlatformRow,
  BackfillResult as CCBackfillResult,
  BackfillReport as CCBackfillReport,
} from './backfill';
export { backfill, mapKind } from './backfill';
