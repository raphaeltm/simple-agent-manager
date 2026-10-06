// Re-export with CC prefix to avoid collision with existing shared types
// (agents.ts exports CredentialKind, types/user.ts exports Credential-related types)
export type {
  Assembler as CCAssembler,
  EnvInjection as CCEnvInjection,
  ProviderConfig as CCProviderConfig,
} from './assemblers';
export { agentAssembler, computeAssembler, sanitizeModelAlias } from './assemblers';
export type {
  BackfillReport as CCBackfillReport,
  BackfillResult as CCBackfillResult,
  SourceCredentialRow as CCSourceCredentialRow,
  SourcePlatformRow as CCSourcePlatformRow,
} from './backfill';
export { backfill, mapKind } from './backfill';
export { resolveEnvironment } from './resolver';
export type {
  Attachment as CCAttachment,
  AttachmentScope as CCAttachmentScope,
  CompositionSnapshot as CCCompositionSnapshot,
  Configuration as CCConfiguration,
  ConfigurationSettings as CCConfigurationSettings,
  ConsumerKind as CCConsumerKind,
  ConsumerRef as CCConsumerRef,
  ConsumerResolutionStatus as CCConsumerResolutionStatus,
  Credential as CCCredential,
  CredentialKind as CCCredentialKind,
  CredentialSecret as CCCredentialSecret,
  PlatformDefault as CCPlatformDefault,
  ResolutionContext as CCResolutionContext,
  ResolutionSource as CCResolutionSource,
  ResolutionStatusResponse as CCResolutionStatusResponse,
  ResolvedEnvironment as CCResolvedEnvironment,
} from './types';
export { consumerKey } from './types';
